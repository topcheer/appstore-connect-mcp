//! data.rs — tools.json types and loading.
//!
//! The generated tools.json is shared with the TypeScript server: it is
//! embedded at compile time so the Rust binary is fully self-contained.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Embedded generated catalog (repo `src/tools.json`).
pub const TOOLS_JSON: &str = include_str!("../../src/tools.json");

/// A single parameter in a tool definition (path or query).
#[derive(Deserialize, Debug, Clone)]
pub struct ToolParam {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    #[allow(dead_code)] // part of tools.json wire format
    pub description: String,
    #[serde(default)]
    pub schema: ParamSchema,
}

/// Simplified JSON schema for a parameter.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct ParamSchema {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<ItemsSchema>,
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub enum_: Option<Vec<String>>,
}

/// Array item schema for a parameter.
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct ItemsSchema {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub enum_: Option<Vec<String>>,
}

/// Compact shape of a success response body (tools.json `responseSchema`).
#[derive(Deserialize, Debug, Clone)]
pub struct ResponseSchemaInfo {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<ResponseData>,
    /// Resource types that may appear in JSON:API "included" documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub included: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ResponseData {
    #[serde(
        rename = "resourceRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_ref: Option<String>,
    #[serde(
        rename = "resourceType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_type: Option<String>,
}

/// A tool definition generated from the OpenAPI spec.
#[derive(Deserialize, Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub summary: String,
    #[allow(dead_code)] // part of tools.json wire format
    pub description: String,
    pub method: String,
    pub path: String,
    pub category: String,
    #[serde(default)]
    pub path_params: Vec<ToolParam>,
    #[serde(default)]
    pub query_params: Vec<ToolParam>,
    #[serde(rename = "hasBody", default)]
    pub has_body: bool,
    /// Key into `body_schemas` for the resolved JSON:API request body schema.
    #[serde(
        rename = "bodySchemaRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub body_schema_ref: Option<String>,
    /// Compact shape of the success response.
    #[serde(
        rename = "responseSchema",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub response_schema: Option<ResponseSchemaInfo>,
}

/// The overall tools.json structure.
#[derive(Deserialize, Debug, Clone)]
pub struct ToolsData {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    #[allow(dead_code)] // part of tools.json wire format
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub stats: Stats,
    pub categories: Vec<String>,
    /// Deduped request body schemas, keyed by Apple spec schema name.
    #[serde(rename = "bodySchemas", default)]
    pub body_schemas: BTreeMap<String, serde_json::Value>,
    /// Deduped resource schemas (response payloads), keyed by resource schema name.
    #[serde(rename = "resourceSchemas", default)]
    pub resource_schemas: BTreeMap<String, serde_json::Value>,
    pub tools: Vec<ToolDef>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Stats {
    pub total: u32,
    #[serde(rename = "by_method", default)]
    pub by_method: BTreeMap<String, u32>,
}

/// Load and parse the embedded tools.json. Panics on corruption — the file
/// is generated and validated in CI, so a parse failure is a build bug.
pub fn load_tools() -> ToolsData {
    serde_json::from_str(TOOLS_JSON).expect("embedded tools.json failed to parse")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_loads_with_schema_enrichment() {
        let data = load_tools();
        assert!(
            data.tools.len() >= 1000,
            "expected 1000+ tools, got {}",
            data.tools.len()
        );
        assert!(!data.body_schemas.is_empty(), "bodySchemas missing");
        assert!(!data.resource_schemas.is_empty(), "resourceSchemas missing");
        let with_body = data
            .tools
            .iter()
            .filter(|t| t.body_schema_ref.is_some())
            .count();
        let with_resp = data
            .tools
            .iter()
            .filter(|t| t.response_schema.is_some())
            .count();
        assert!(
            with_body > 300,
            "expected 300+ tools with bodySchemaRef, got {with_body}"
        );
        assert!(
            with_resp > 1000,
            "expected 1000+ tools with responseSchema, got {with_resp}"
        );
    }

    #[test]
    fn known_tool_fields_deserialize() {
        let data = load_tools();
        let t = data
            .tools
            .iter()
            .find(|t| t.name == "accessibilityDeclarations_createInstance")
            .expect("tool missing");
        assert_eq!(t.method, "POST");
        assert!(t.has_body);
        assert_eq!(
            t.body_schema_ref.as_deref(),
            Some("AccessibilityDeclarationCreateRequest")
        );
    }
}
