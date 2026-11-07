//! tools.rs - Core tool logic: search, details, and schema-derived examples.
//!
//! Mirrors src/tools.ts + the get_tool_details/example logic in src/server.ts.

use crate::data::{ToolDef, ToolsData};
use serde_json::{Map, Value, json};

const MAX_DESCRIPTION: usize = 500;
const MAX_ENUM: usize = 40;

/// Cap long spec descriptions (some field docs run >1KB and poison LLM context).
pub fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_DESCRIPTION {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_DESCRIPTION).collect();
    format!("{cut}...")
}

/// Cap long enum lists (fields[...] enums enumerate whole resource schemas).
pub fn cap_enum(values: &[String]) -> Vec<String> {
    if values.len() <= MAX_ENUM {
        return values.to_vec();
    }
    let mut out: Vec<String> = values[..MAX_ENUM].to_vec();
    out.push(format!("... (+{} more)", values.len() - MAX_ENUM));
    out
}

/// search_apis: substring match over name+summary+path+category.
pub fn search<'a>(
    data: &'a ToolsData,
    query: &str,
    category: Option<&str>,
    method: Option<&str>,
) -> Vec<&'a ToolDef> {
    let q = query.to_lowercase();
    data.tools
        .iter()
        .filter(|t| {
            if let Some(c) = category
                && t.category != c
            {
                return false;
            }
            if let Some(m) = method
                && t.method != m
            {
                return false;
            }
            format!("{} {} {} {}", t.name, t.summary, t.path, t.category)
                .to_lowercase()
                .contains(&q)
        })
        .collect()
}

/// get_tool_details payload: params + body schema + response schema + example.
/// Emitted as compact JSON (consumed by an LLM; pretty-printing would nearly
/// double its size).
pub fn tool_details(tool: &ToolDef, data: &ToolsData) -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), json!(tool.name));
    obj.insert("summary".into(), json!(tool.summary));
    obj.insert("method".into(), json!(tool.method));
    obj.insert("path".into(), json!(tool.path));
    obj.insert("category".into(), json!(tool.category));

    let path_params: Vec<Value> = tool
        .path_params
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "required": p.required,
                "description": truncate(&p.description),
                "schema": serde_json::to_value(&p.schema).unwrap_or(Value::Null),
            })
        })
        .collect();
    obj.insert("pathParams".into(), Value::Array(path_params));

    let query_params: Vec<Value> = tool
        .query_params
        .iter()
        .map(|p| {
            let mut q = Map::new();
            q.insert("name".into(), json!(p.name));
            q.insert("required".into(), json!(p.required));
            q.insert("description".into(), json!(truncate(&p.description)));
            if let Some(t) = &p.schema.type_ {
                q.insert("type".into(), json!(t));
            }
            if let Some(items) = &p.schema.items
                && let Some(e) = &items.enum_
            {
                q.insert("enum".into(), json!(cap_enum(e)));
            }
            if let Some(e) = &p.schema.enum_ {
                q.insert("enum".into(), json!(cap_enum(e)));
            }
            Value::Object(q)
        })
        .collect();
    obj.insert("queryParams".into(), Value::Array(query_params));

    obj.insert("hasBody".into(), json!(tool.has_body));

    if let Some(bs) = tool
        .body_schema_ref
        .as_ref()
        .and_then(|r| data.body_schemas.get(r))
    {
        obj.insert("bodySchema".into(), bs.clone());
    }

    if let Some(rs) = &tool.response_schema {
        let mut resp = Map::new();
        resp.insert("kind".into(), json!(rs.kind));
        if let Some(d) = &rs.data {
            let mut dv = Map::new();
            if let Some(r) = &d.resource_ref {
                dv.insert("resourceRef".into(), json!(r));
            }
            if let Some(t) = &d.resource_type {
                dv.insert("resourceType".into(), json!(t));
            }
            resp.insert("data".into(), Value::Object(dv));
        }
        if let Some(inc) = &rs.included {
            resp.insert("included".into(), json!(inc));
        }
        if let Some(rname) = rs.data.as_ref().and_then(|d| d.resource_ref.as_ref())
            && let Some(resource) = data.resource_schemas.get(rname)
        {
            resp.insert("resource".into(), resource.clone());
        }
        obj.insert("responseSchema".into(), Value::Object(resp));
    }

    obj.insert("example".into(), build_example(tool, data));
    Value::Object(obj)
}

/// Build a usage example for a tool to help the LLM call it correctly.
pub fn build_example(tool: &ToolDef, data: &ToolsData) -> Value {
    let mut example = Map::new();
    for p in &tool.path_params {
        let v = if p.name == "id" {
            json!("1234567890")
        } else {
            json!(format!("<{}>", p.name))
        };
        example.insert(p.name.clone(), v);
    }
    if let Some(first) = tool.query_params.first() {
        let is_array = first.schema.type_.as_deref() == Some("array");
        let v = if is_array {
            json!(["value1"])
        } else {
            json!("value")
        };
        example.insert(first.name.clone(), v);
    }
    if tool.has_body {
        example.insert("_body".into(), body_example(tool, data));
    }
    Value::Object(example)
}

/// Build a realistic _body example from the resolved body schema, so the LLM
/// sees the exact data.type, attribute names and relationship targets.
fn body_example(tool: &ToolDef, data: &ToolsData) -> Value {
    let bs = tool
        .body_schema_ref
        .as_ref()
        .and_then(|r| data.body_schemas.get(r));
    let Some(data_def) = bs.and_then(|v| v.get("data")) else {
        return json!({ "data": { "type": "resourceType", "attributes": {} } });
    };

    let mut d = Map::new();
    let type_val = data_def
        .get("type")
        .and_then(|t| t.get("enum"))
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(json!("<resourceType>"));
    d.insert("type".into(), type_val);

    if let Some(attrs) = data_def
        .get("attributes")
        .and_then(|a| a.get("properties"))
        .and_then(Value::as_object)
    {
        let mut m = Map::new();
        for (k, v) in attrs {
            m.insert(k.clone(), placeholder(v));
        }
        d.insert("attributes".into(), Value::Object(m));
    }

    if let Some(rels) = data_def
        .get("relationships")
        .and_then(|a| a.get("properties"))
        .and_then(Value::as_object)
    {
        let mut m = Map::new();
        for (k, v) in rels {
            let target = v
                .get("data")
                .and_then(|d| d.get("type"))
                .and_then(|t| t.get("enum"))
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(json!("<resourceType>"));
            let is_many = v.get("kind").and_then(Value::as_str) == Some("toMany");
            let rel = if is_many {
                json!({ "data": [{ "type": target, "id": "<related-id>" }] })
            } else {
                json!({ "data": { "type": target, "id": "<related-id>" } })
            };
            m.insert(k.clone(), rel);
        }
        d.insert("relationships".into(), Value::Object(m));
    }

    json!({ "data": Value::Object(d) })
}

/// Produce a plausible placeholder value for a compact schema node.
pub fn placeholder(v: &Value) -> Value {
    let Some(obj) = v.as_object() else {
        return json!("value");
    };
    if let Some(first) = obj
        .get("enum")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        return first.clone();
    }
    if obj.get("nullable").and_then(Value::as_bool) == Some(true) {
        return Value::Null;
    }
    match obj.get("type").and_then(Value::as_str) {
        Some("boolean") => json!(true),
        Some("integer") | Some("number") => json!(1),
        Some("array") => {
            let item = obj.get("items").map(placeholder).unwrap_or(json!("value"));
            json!([item])
        }
        Some("object") => {
            if let Some(props) = obj.get("properties").and_then(Value::as_object) {
                let mut m = Map::new();
                for (k, sv) in props {
                    m.insert(k.clone(), placeholder(sv));
                }
                Value::Object(m)
            } else {
                json!({})
            }
        }
        _ => json!("string"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::load_tools;

    #[test]
    fn truncate_caps_long_descriptions() {
        assert_eq!(truncate("short"), "short");
        let long = "x".repeat(600);
        let t = truncate(&long);
        assert!(t.chars().count() == MAX_DESCRIPTION + 3);
        assert!(t.ends_with("..."));
    }

    #[test]
    fn cap_enum_appends_overflow_marker() {
        let vals: Vec<String> = (0..45).map(|i| format!("v{i}")).collect();
        let capped = cap_enum(&vals);
        assert_eq!(capped.len(), MAX_ENUM + 1);
        assert_eq!(capped.last().unwrap(), "... (+5 more)");
        assert_eq!(cap_enum(&["a".into()]), ["a"]);
    }

    #[test]
    fn search_matches_substring() {
        let data = load_tools();
        let hits = search(&data, "apps_getcollection", None, None);
        assert!(hits.iter().any(|t| t.name == "apps_getCollection"));
        let none = search(&data, "zzz_no_such_thing", None, None);
        assert!(none.is_empty());
        let by_method = search(&data, "app", None, Some("DELETE"));
        assert!(by_method.iter().all(|t| t.method == "DELETE"));
    }

    #[test]
    fn create_instance_details_carry_body_and_response_schemas() {
        let data = load_tools();
        let tool = data
            .tools
            .iter()
            .find(|t| t.name == "accessibilityDeclarations_createInstance")
            .unwrap();
        let d = tool_details(tool, &data);
        let bs = d.get("bodySchema").expect("bodySchema must be present");
        let dtype = bs.pointer("/data/type/enum/0").unwrap();
        assert_eq!(dtype, "accessibilityDeclarations");
        let rel_target = bs
            .pointer("/data/relationships/properties/app/data/type/enum/0")
            .unwrap();
        assert_eq!(rel_target, "apps");

        let rs = d
            .get("responseSchema")
            .expect("responseSchema must be present");
        assert_eq!(rs.get("kind").unwrap(), "single");
        assert_eq!(
            rs.pointer("/resource/resourceType").unwrap(),
            "accessibilityDeclarations"
        );

        let example = d
            .get("example")
            .and_then(|e| e.get("_body"))
            .expect("_body example");
        assert_eq!(
            example.pointer("/data/type").unwrap(),
            "accessibilityDeclarations"
        );
        assert_eq!(
            example
                .pointer("/data/relationships/app/data/type")
                .unwrap(),
            "apps"
        );
        assert_eq!(
            example.pointer("/data/attributes/deviceFamily").unwrap(),
            "IPHONE"
        );
    }

    #[test]
    fn placeholder_walks_nested_schema() {
        let v = json!({"type": "object", "properties": {
            "s": {"type": "string", "enum": ["A", "B"]},
            "n": {"type": "integer"},
            "b": {"type": "boolean"},
            "arr": {"type": "array", "items": {"type": "string"}},
            "nullable": {"type": "string", "nullable": true}
        }});
        let p = placeholder(&v);
        assert_eq!(p.pointer("/s"), Some(&json!("A")));
        assert_eq!(p.pointer("/n"), Some(&json!(1)));
        assert_eq!(p.pointer("/b"), Some(&json!(true)));
        assert_eq!(p.pointer("/arr"), Some(&json!(["string"])));
        assert_eq!(p.pointer("/nullable"), Some(&Value::Null));
    }
}
