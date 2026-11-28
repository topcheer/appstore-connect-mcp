//! knowledge.rs - Task recipes + ranked search over the operation catalog.
//!
//! Mirrors src/recipes.ts + src/search.ts. The curated knowledge lives in
//! `recipes.json` (single source of truth, generated into this crate by
//! scripts/build-skills.mjs so the binary stays self-contained).
//!
//! Why this exists: Apple's OpenAPI spec carries zero descriptions, so a
//! literal-substring search over operation names misses most natural-language
//! queries ("submit for review", "testflight", "pricing"). Recipes encode the
//! multi-call workflows (which operation ids form a task, in which order);
//! the ranked search uses tokenization, a synonym table, inverse document
//! frequency and intent phrases to put the right operation first.

use crate::data::{ToolDef, ToolsData};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const RECIPES_JSON: &str = include_str!("../recipes.json");

// ── Knowledge data ─────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct RecipeArg {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Recipe {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub args: Vec<RecipeArg>,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub pitfalls: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Knowledge {
    #[serde(default)]
    pub synonyms: HashMap<String, Vec<String>>,
    /// Intent phrases -> operations pinned to the top of search results.
    #[serde(default)]
    pub phrases: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub recipes: Vec<Recipe>,
}

pub fn load_knowledge() -> Knowledge {
    serde_json::from_str(RECIPES_JSON).expect("embedded recipes.json must parse")
}

// ── Tokenization ───────────────────────────────────────────────────────────

/// Split "reviewSubmissionItems_createInstance" / "appScreenshotSet" into words.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        if part.is_empty() {
            continue;
        }
        let chars: Vec<char> = part.chars().collect();
        let mut start = 0;
        for i in 1..chars.len() {
            let prev = chars[i - 1];
            let cur = chars[i];
            let next_lower = chars.get(i + 1).map(|c| c.is_ascii_lowercase());
            let boundary = (prev.is_ascii_lowercase() || prev.is_ascii_digit())
                && cur.is_ascii_uppercase()
                || (prev.is_ascii_uppercase()
                    && cur.is_ascii_uppercase()
                    && next_lower == Some(true));
            if boundary {
                out.push(chars[start..i].iter().collect::<String>().to_lowercase());
                start = i;
            }
        }
        out.push(chars[start..].iter().collect::<String>().to_lowercase());
    }
    out
}

/// Singularize so "tester" matches "betaTesters", "submission" matches "reviewSubmissions".
pub fn norm(t: &str) -> String {
    if t.len() > 3 && t.ends_with('s') {
        t[..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

const STOP: &[&str] = &[
    "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "my", "get", "list", "find",
    "show", "me", "all", "how", "do", "i", "can", "what", "is", "are", "with", "by", "from",
    "into", "new", "up", "use", "using", "that", "this",
];

pub fn query_tokens(query: &str) -> Vec<String> {
    tokenize(query)
        .into_iter()
        .filter(|t| t.len() > 1 && !STOP.contains(&t.as_str()))
        .collect()
}

fn expand(token: &str, synonyms: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut v = vec![token.to_string()];
    if let Some(s) = synonyms.get(token) {
        v.extend(s.iter().cloned());
    }
    v
}

/// Prefer the primary resource actions over linkage helpers.
fn action_bonus(name: &str) -> f32 {
    if name.ends_with("Relationship") {
        -1.0
    } else if name.ends_with("_createInstance") {
        1.0
    } else if name.ends_with("_updateInstance") {
        0.8
    } else if name.ends_with("_getCollection") || name.ends_with("_deleteInstance") {
        0.6
    } else if name.ends_with("_getInstance") {
        0.4
    } else {
        0.0
    }
}

struct Indexed {
    tool: ToolDef,
    /// first snake_case segment of the name, lowercased + singularized ("apps" -> "app")
    resource: String,
    tokens: HashSet<String>,
    name_tokens: HashSet<String>,
    path_tokens: HashSet<String>,
    category_tokens: HashSet<String>,
    action_bonus: f32,
    hay: String,
}

// ── Ranked search ──────────────────────────────────────────────────────────

pub struct OpSearch {
    index: Vec<Indexed>,
    synonyms: HashMap<String, Vec<String>>,
    phrases: Vec<(Vec<String>, Vec<String>)>,
    recipes: Vec<(String, HashSet<String>)>,
    idf: HashMap<String, f32>,
}

impl OpSearch {
    pub fn new(data: &ToolsData, knowledge: &Knowledge) -> Self {
        let mut df: HashMap<String, usize> = HashMap::new();
        let mut index = Vec::with_capacity(data.tools.len());
        for tool in &data.tools {
            let name_tokens: HashSet<String> =
                tokenize(&tool.name).iter().map(|t| norm(t)).collect();
            let path_tokens: HashSet<String> =
                tokenize(&tool.path).iter().map(|t| norm(t)).collect();
            let category_tokens: HashSet<String> =
                tokenize(&tool.category).iter().map(|t| norm(t)).collect();
            let summary_tokens: HashSet<String> =
                tokenize(&tool.summary).iter().map(|t| norm(t)).collect();
            let mut tokens = HashSet::new();
            for s in [
                &name_tokens,
                &path_tokens,
                &category_tokens,
                &summary_tokens,
            ] {
                tokens.extend(s.iter().cloned());
            }
            for t in &tokens {
                *df.entry(t.clone()).or_insert(0) += 1;
            }
            let resource = norm(
                tool.name
                    .split('_')
                    .next()
                    .unwrap_or("")
                    .to_lowercase()
                    .as_str(),
            );
            let hay = format!(
                "{} {} {} {}",
                tool.name, tool.summary, tool.path, tool.category
            )
            .to_lowercase();
            index.push(Indexed {
                tool: tool.clone(),
                resource,
                tokens,
                name_tokens,
                path_tokens,
                category_tokens,
                action_bonus: action_bonus(&tool.name),
                hay,
            });
        }
        let n = data.tools.len().max(1) as f32;
        let idf = df
            .iter()
            .map(|(t, c)| (t.clone(), (1.0 + n / *c as f32).ln()))
            .collect();

        let phrases = knowledge
            .phrases
            .iter()
            .map(|(p, ops)| (query_tokens(p), ops.clone()))
            .collect();
        let recipes = knowledge
            .recipes
            .iter()
            .map(|r| {
                let mut set = HashSet::new();
                for t in tokenize(&r.id)
                    .into_iter()
                    .chain(tokenize(&r.title))
                    .chain(tokenize(&r.description))
                {
                    set.insert(norm(&t));
                }
                (r.id.clone(), set)
            })
            .collect();

        Self {
            index,
            synonyms: knowledge.synonyms.clone(),
            phrases,
            recipes,
            idf,
        }
    }

    fn score_token(&self, ix: &Indexed, variants: &[String]) -> f32 {
        let mut best: f32 = 0.0;
        for (i, raw) in variants.iter().enumerate() {
            let v = norm(raw);
            let syn_w = if i == 0 { 1.0 } else { 0.6 };
            let mut s = 0.0;
            if ix.name_tokens.contains(&v) {
                s = 5.0;
            } else if ix.category_tokens.contains(&v) {
                s = 4.0;
            } else if ix.path_tokens.contains(&v) || ix.tokens.contains(&v) {
                // path token, or summary token (both medium signal)
                s = 3.0;
            } else if v.len() >= 4 && ix.name_tokens.iter().any(|t| t.starts_with(&v)) {
                s = 2.0;
            } else if ix.hay.contains(&v) {
                s = 1.0;
            }
            if s > 0.0 {
                let idf = self.idf.get(&v).copied().unwrap_or(1.0);
                best = best.max((s / 5.0) * idf * syn_w);
            }
        }
        best
    }

    /// Operations pinned by an intent phrase whose tokens are all in the query.
    fn pinned(&self, query_tokens: &[String]) -> Vec<String> {
        let q: HashSet<&str> = query_tokens.iter().map(String::as_str).collect();
        let mut hits: Vec<(usize, &Vec<String>)> = self
            .phrases
            .iter()
            .filter(|(pt, _)| !pt.is_empty() && pt.iter().all(|t| q.contains(t.as_str())))
            .map(|(pt, ops)| (pt.len(), ops))
            .collect();
        hits.sort_by_key(|(len, _)| std::cmp::Reverse(*len));
        hits.into_iter()
            .flat_map(|(_, ops)| ops.iter().cloned())
            .collect()
    }

    /// Recipe ids whose id/title/description share tokens with the query.
    pub fn related_recipes(&self, query: &str) -> Vec<String> {
        let tokens = query_tokens(query);
        if tokens.is_empty() {
            return Vec::new();
        }
        let mut scored: Vec<(usize, String)> = self
            .recipes
            .iter()
            .map(|(id, set)| {
                let hits = tokens.iter().filter(|t| set.contains(&norm(t))).count();
                (hits, id.clone())
            })
            .filter(|(hits, id)| {
                *hits >= if tokens.len() == 1 { 1 } else { 2 } || tokens.iter().any(|t| t == id)
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.into_iter().take(3).map(|(_, id)| id).collect()
    }

    pub fn search(
        &self,
        query: &str,
        category: Option<&str>,
        method: Option<&str>,
    ) -> Vec<ToolDef> {
        let tokens = query_tokens(query);
        let pins = self.pinned(&tokens);
        let mut scored: Vec<(f32, ToolDef)> = Vec::new();

        for ix in &self.index {
            if let Some(c) = category
                && ix.tool.category != c
            {
                continue;
            }
            if let Some(m) = method
                && ix.tool.method != m
            {
                continue;
            }
            if tokens.is_empty() {
                let q = query.trim().to_lowercase();
                if q.is_empty() || ix.hay.contains(&q) {
                    scored.push((1.0, ix.tool.clone()));
                }
                continue;
            }

            let mut total = 0.0;
            let mut strong = 0;
            for t in &tokens {
                let s = self.score_token(ix, &expand(t, &self.synonyms));
                total += s;
                if s >= 0.5 {
                    strong += 1;
                }
            }
            // A token naming the resource itself ("app" -> apps_*) is the strongest signal.
            if tokens.iter().any(|t| {
                let n = norm(t);
                ix.resource == n || (n.len() >= 4 && ix.resource.starts_with(&n))
            }) {
                total += 1.0;
            }

            let pin = pins.iter().position(|p| p == &ix.tool.name);
            if pin.is_none() && strong == 0 {
                continue;
            }
            if let Some(p) = pin {
                total += 100.0 - p as f32 * 10.0;
            }
            total += ix.action_bonus * total.min(1.0);
            total -= ix.tool.name.len() as f32 / 500.0;
            scored.push((total, ix.tool.clone()));
        }

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.name.cmp(&b.1.name)));
        scored.into_iter().map(|(_, t)| t).collect()
    }
}

// ── Prompt rendering / instructions ────────────────────────────────────────

/// Substitute {{arg}} placeholders with caller-supplied values.
pub fn render_recipe(recipe: &Recipe, args: &HashMap<String, String>) -> String {
    let sub = |text: &str| -> String {
        let mut out = text.to_string();
        for a in &recipe.args {
            let v = args
                .get(&a.name)
                .cloned()
                .unwrap_or_else(|| format!("<{}>", a.name));
            out = out.replace(&format!("{{{{{}}}}}", a.name), &v);
        }
        out
    };

    let mut lines = vec![format!("# {}", recipe.title), String::new()];
    lines.push(
        "Every operation below is called through `call_api` with `name` = the operation name. \
         Call `get_tool_details(name)` before the first POST/PATCH of each operation to get the exact \
         body schema and attribute enums. Responses are JSON:API: ids come from `data.id` / `data[].id`. \
         Operation names and body fields are verified against the API catalog; the step order follows Apple's \
         documented workflows - if a step fails with 403/409, re-read the error and adjust rather than retrying blindly."
            .to_string(),
    );
    lines.push(String::new());
    for step in &recipe.steps {
        lines.push(sub(step));
    }
    if !recipe.pitfalls.is_empty() {
        lines.push(String::new());
        lines.push("## Pitfalls".to_string());
        for p in &recipe.pitfalls {
            lines.push(format!("- {}", sub(p)));
        }
    }
    lines.join("\n")
}

/// Server instructions injected into the model's context at initialize.
pub fn instructions(knowledge: &Knowledge, total_ops: usize) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "App Store Connect API with {total_ops} operations exposed through 4 tools (search_apis, get_tool_details, call_api, list_categories).\n\n"
    ));
    s.push_str("## How to find the right operation\n");
    s.push_str("- search_apis is tokenized and ranked; use 1-4 keywords (e.g. 'review submit', 'beta tester', 'price'). Common terms are mapped to API vocabulary (testflight->beta, pricing->pricePoint, promo->offerCode, listing->appStoreVersionLocalization).\n");
    s.push_str("- Names follow <resource>_<action>: getCollection / getInstance / createInstance / updateInstance / deleteInstance / <related>_getToManyRelated / <related>_createToManyRelationship. Filtering is done with query params like filter[app], filter[platform], sort=-createdDate, limit, fields[<type>].\n");
    s.push_str("- Always call get_tool_details(name) before call_api for POST/PATCH: it returns the exact JSON:API body (data.type, attributes, relationships) and an example body. GETs only need the path params shown in the path.\n");
    s.push_str("- Results are JSON:API. Chain ids: data[0].id, data.id, included[]. For collections follow links.next (pass its query params) to paginate.\n");
    s.push_str("- Apps cannot be created and IAP products cannot be created through this API; everything else below is supported.\n\n");
    s.push_str("## Task recipes (multi-call workflows)\n");
    s.push_str("For these tasks, fetch the recipe first with prompts/get (name = recipe id, pass its arguments) instead of discovering the chain by searching:\n");
    for r in &knowledge.recipes {
        let d = r
            .description
            .strip_prefix("Use when the user wants to ")
            .unwrap_or(&r.description);
        s.push_str(&format!("- {}: {}\n", r.id, d));
    }
    s.push_str("\nDestructive calls (deleteInstance, replace/delete relationships, submitted=true) require explicit user confirmation of the target id.");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::load_tools;

    fn setup() -> (ToolsData, Knowledge) {
        (load_tools(), load_knowledge())
    }

    #[test]
    fn tokenize_splits_camel_and_snake() {
        assert_eq!(
            tokenize("appStoreVersions_getToManyRelated"),
            ["app", "store", "versions", "get", "to", "many", "related"]
        );
    }

    #[test]
    fn natural_language_queries_find_the_operation() {
        let (data, k) = setup();
        let s = OpSearch::new(&data, &k);
        let top = |q: &str| {
            s.search(q, None, None)
                .iter()
                .take(6)
                .map(|t| t.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            top("submit app for review")[0],
            "reviewSubmissions_createInstance"
        );
        assert_eq!(top("replace build")[0], "appStoreVersions_updateInstance");
        assert_eq!(top("beta tester")[0], "betaTesters_createInstance");
        assert!(top("upload build")[0].starts_with("buildUploads_createInstance"));
        assert!(
            top("pricing")
                .iter()
                .take(6)
                .any(|n| n.contains("PricePoint"))
        );
        assert!(top("testflight").iter().any(|n| n.starts_with("beta")));
        assert!(top("app")[0].starts_with("apps_"));
        assert!(s.search("zzzqqqxyz", None, None).is_empty());
        assert!(
            s.search("tester", Some("BetaTesters"), Some("POST"))
                .iter()
                .all(|t| t.method == "POST")
        );
    }

    #[test]
    fn related_recipes_point_at_the_task() {
        let (data, k) = setup();
        let s = OpSearch::new(&data, &k);
        assert!(
            s.related_recipes("replace build")
                .contains(&"replace-build-on-version".to_string())
        );
        assert!(
            s.related_recipes("submit for review")
                .contains(&"submit-for-review".to_string())
        );
    }

    #[test]
    fn embedded_recipes_reference_only_known_operations() {
        let (data, k) = setup();
        let names: HashSet<&str> = data.tools.iter().map(|t| t.name.as_str()).collect();
        assert!(k.recipes.len() >= 18);
        for r in &k.recipes {
            for text in r.steps.iter().chain(&r.pitfalls) {
                for op in text.split('`').skip(1).step_by(2) {
                    let looks_like_op = op.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                        && op.contains('_')
                        && op
                            .chars()
                            .next()
                            .map(|c| c.is_ascii_lowercase())
                            .unwrap_or(false);
                    if looks_like_op {
                        assert!(
                            names.contains(op),
                            "{} references unknown operation {op}",
                            r.id
                        );
                    }
                }
            }
        }
        for ops in k.phrases.values() {
            for op in ops {
                assert!(
                    names.contains(op.as_str()),
                    "phrase references unknown operation {op}"
                );
            }
        }
    }

    #[test]
    fn render_substitutes_args_and_lists_pitfalls() {
        let (_, k) = setup();
        let r = k
            .recipes
            .iter()
            .find(|r| r.id == "submit-for-review")
            .unwrap();
        let mut args = HashMap::new();
        args.insert("app_id".to_string(), "123456789".to_string());
        let text = render_recipe(r, &args);
        assert!(text.contains("path id=123456789"));
        assert!(text.contains("reviewSubmissions_createInstance"));
        assert!(text.contains("## Pitfalls"));
        assert!(!text.contains("{{"));
    }

    #[test]
    fn instructions_index_every_recipe() {
        let (_, k) = setup();
        let text = instructions(&k, 1216);
        for r in &k.recipes {
            assert!(text.contains(&r.id));
        }
        assert!(text.contains("prompts/get"));
    }
}
