/**
 * search.ts - Ranked, tokenized search over the 1216 API operations.
 *
 * Replaces the original literal-substring filter, which missed most
 * natural-language queries ("submit for review", "testflight", "pricing"
 * all returned 0 because Apple's spec carries no descriptions and the
 * summaries are derived from operationIds).
 *
 * Model: tokenize the query, expand each token through a curated synonym
 * table, then score every operation by where and how well tokens match,
 * weighted by inverse document frequency - "app" appears in ~480 of 1216
 * operations and carries almost no signal, "review" appears in a handful
 * and carries a lot. Tokens are NOT required to all match: a query like
 * "submit app for review" must still surface reviewSubmissions_createInstance,
 * which has no "app" token. At least one token must match strongly.
 */

import type { ToolDef, ToolsData } from "./types.js";
import type { Knowledge } from "./recipes.js";

/** Split "reviewSubmissionItems_createInstance" / "appScreenshotSet" into words. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    // camelCase boundaries: "appStoreVersions" -> app, Store, Versions
    for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (w) out.push(w.toLowerCase());
    }
  }
  return out;
}

/** Tokens of a query, with stop words removed. */
export function queryTokens(query: string): string[] {
  const STOP = new Set([
    "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "my",
    "get", "list", "find", "show", "me", "all", "how", "do", "i", "can",
    "what", "is", "are", "with", "by", "from", "into", "new", "up", "use",
    "using", "that", "this",
  ]);
  return tokenize(query).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Expand a token with its synonyms (the token itself is kept). */
export function expand(token: string, synonyms: Record<string, string[]>): string[] {
  const syn = synonyms[token] ?? [];
  return [token, ...syn];
}

/** Singularize so "tester" matches "betaTesters", "submission" matches "reviewSubmissions". */
const norm = (t: string) => (t.length > 3 ? t.replace(/s$/, "") : t);

interface Indexed {
  tool: ToolDef;
  resource: string; // norm(first name segment), e.g. "apps", "reviewSubmission"
  tokens: Set<string>; // name + path + category + summary, normalized
  nameTokens: Set<string>;
  pathTokens: Set<string>;
  categoryTokens: Set<string>;
  actionBonus: number;
  hay: string;
}

/** Prefer the primary resource actions over linkage helpers. */
function actionBonus(name: string): number {
  if (/(Relationship)$/.test(name)) return -1.0; // linkage-only endpoints
  if (/_createInstance$/.test(name)) return 1.0;
  if (/_updateInstance$/.test(name)) return 0.8;
  if (/_getCollection$/.test(name)) return 0.6;
  if (/_deleteInstance$/.test(name)) return 0.6;
  if (/_getInstance$/.test(name)) return 0.4;
  return 0;
}

/** Normalized tokens of a recipe's id + title + description, for "did you mean this task" hints. */
function recipeTokens(r: { id: string; title: string; description: string }): Set<string> {
  return new Set([...tokenize(r.id), ...tokenize(r.title), ...tokenize(r.description)].map(norm));
}

export class OpSearch {
  private index: Indexed[];
  private synonyms: Record<string, string[]>;
  /** inverse document frequency per token across the catalog */
  private idf = new Map<string, number>();
  /** intent phrases -> operations pinned to the top, e.g. "replace build" */
  private phrases: Record<string, string[]> = {};
  private recipes: { id: string; tokens: Set<string> }[] = [];

  constructor(data: ToolsData, knowledge: Knowledge) {
    this.synonyms = knowledge.synonyms ?? {};
    this.phrases = knowledge.phrases ?? {};
    this.recipes = (knowledge.recipes ?? []).map((r) => ({ id: r.id, tokens: recipeTokens(r) }));
    const df = new Map<string, number>();
    const raw: Indexed[] = data.tools.map((tool) => {
      const nameTokens = new Set(tokenize(tool.name).map(norm));
      const pathTokens = new Set(tokenize(tool.path).map(norm));
      const categoryTokens = new Set(tokenize(tool.category).map(norm));
      const summaryTokens = new Set(tokenize(tool.summary).map(norm));
      const tokens = new Set([...nameTokens, ...pathTokens, ...categoryTokens, ...summaryTokens]);
      for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
      return {
        tool,
        resource: norm((tool.name.split("_")[0] ?? "").toLowerCase()),
        tokens,
        nameTokens,
        pathTokens,
        categoryTokens,
        actionBonus: actionBonus(tool.name),
        hay: `${tool.name} ${tool.summary} ${tool.path} ${tool.category}`.toLowerCase(),
      };
    });
    const n = Math.max(1, data.tools.length);
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + n / c));
    this.index = raw;
  }

  /** Best score of one query token (or its synonyms) against one operation. */
  private scoreToken(ix: Indexed, variants: string[]): number {
    let best = 0;
    for (let i = 0; i < variants.length; i++) {
      const v = norm(variants[i]);
      const synW = i === 0 ? 1 : 0.6;
      let s = 0;
      if (ix.nameTokens.has(v)) s = 5;
      else if (ix.categoryTokens.has(v)) s = 4;
      else if (ix.pathTokens.has(v)) s = 3;
      else if (ix.tokens.has(v)) s = 3; // summary
      else if ([...ix.nameTokens].some((t) => t.startsWith(v) && v.length >= 4)) s = 2;
      else if (ix.hay.includes(v)) s = 1;
      if (s > 0) best = Math.max(best, (s / 5) * (this.idf.get(v) ?? 1) * synW);
    }
    return best;
  }

  /** Operations pinned by an intent phrase whose tokens are all in the query (extra words allowed). */
  private pinned(query: string): string[] {
    const q = new Set(queryTokens(query));
    const hits = Object.entries(this.phrases)
      .filter(([phrase]) => {
        const pt = queryTokens(phrase);
        return pt.length > 0 && pt.every((t) => q.has(t));
      })
      .sort((a, b) => b[0].length - a[0].length);
    return hits.flatMap(([, ops]) => ops);
  }

  /** Recipe ids whose id/title/description share tokens with the query. */
  relatedRecipes(query: string): string[] {
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    return this.recipes
      .map((r) => ({
        id: r.id,
        hits: tokens.reduce((n, t) => n + (r.tokens.has(norm(t)) ? 1 : 0), 0),
      }))
      .filter((r) => r.hits >= (tokens.length === 1 ? 1 : 2) || (tokens.includes(r.id) ? true : false))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3)
      .map((r) => r.id);
  }

  search(query: string, category?: string, method?: string): ToolDef[] {
    const tokens = queryTokens(query);
    const pins = this.pinned(query);
    const scored: { tool: ToolDef; score: number }[] = [];

    for (const ix of this.index) {
      if (category && ix.tool.category !== category) continue;
      if (method && ix.tool.method !== method) continue;

      // No usable tokens: fall back to raw substring so odd queries still work.
      if (tokens.length === 0) {
        const q = query.trim().toLowerCase();
        if (!q || ix.hay.includes(q)) scored.push({ tool: ix.tool, score: 1 });
        continue;
      }

      let total = 0;
      let strong = 0; // tokens that matched on name/path/category/summary (not substring)
      for (const t of tokens) {
        const s = this.scoreToken(ix, expand(t, this.synonyms));
        total += s;
        if (s >= 0.5) strong++;
      }
      // A token naming the resource itself ("app" -> apps_*, "build" -> builds_*) is the
      // strongest single signal; flat bonus so generic action bonuses cannot outrank it.
      if (tokens.some((t) => ix.resource === norm(t) || (norm(t).length >= 4 && ix.resource.startsWith(norm(t))))) {
        total += 1.0;
      }

      const pin = pins.indexOf(ix.tool.name);
      if (pin === -1 && strong === 0) continue; // nothing real matched

      // Intent phrases win outright; earlier pins rank higher.
      if (pin !== -1) total += 100 - pin * 10;
      total += ix.actionBonus * Math.min(1, total); // bonus scales with match strength
      total -= ix.tool.name.length / 500; // shorter = more canonical
      scored.push({ tool: ix.tool, score: total });
    }

    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    return scored.map((s) => s.tool);
  }
}
