//! mcp.rs - MCP protocol: JSON-RPC dispatch for the 4 tools + stdio loop.
//!
//! Mirrors src/server.ts. Protocol over stdio is newline-delimited JSON-RPC 2.0.

use crate::auth::TokenCache;
use crate::client;
use crate::data::load_tools;
use crate::knowledge::{self, Knowledge, OpSearch};
use crate::tools;
use crate::types::Credentials;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const SERVER_NAME: &str = "appstore-connect-mcp";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const MAX_RESPONSE_BYTES: usize = 25_000;

pub struct Mcp {
    pub data: crate::data::ToolsData,
    pub knowledge: Knowledge,
    /// Ranked, synonym-aware search over `data.tools` (see knowledge.rs).
    pub search: OpSearch,
    pub creds: Credentials,
    pub verbose: bool,
    pub tokens: TokenCache,
    pub http: reqwest::Client,
}

impl Mcp {
    pub fn new(creds: Credentials, verbose: bool) -> Self {
        let data = load_tools();
        let knowledge = knowledge::load_knowledge();
        let search = OpSearch::new(&data, &knowledge);
        Self {
            data,
            knowledge,
            search,
            creds,
            verbose,
            tokens: TokenCache::default(),
            http: reqwest::Client::new(),
        }
    }

    /// Handle one JSON-RPC message (or batch). Returns the response message,
    /// or None for notifications / empty batches.
    pub async fn handle_message(&self, msg: &Value) -> Option<Value> {
        if let Some(batch) = msg.as_array() {
            let mut out = Vec::new();
            for m in batch {
                if let Some(r) = self.handle_single(m).await {
                    out.push(r);
                }
            }
            return if out.is_empty() {
                None
            } else {
                Some(Value::Array(out))
            };
        }
        self.handle_single(msg).await
    }

    fn handle_single<'a>(
        &'a self,
        msg: &'a Value,
    ) -> impl Future<Output = Option<Value>> + Send + 'a {
        Box::pin(async move {
            let id = match msg.get("id") {
                Some(id) => id.clone(),
                None => return None, // notification: no response
            };
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            if method.starts_with("notifications/") {
                return None;
            }
            let params = msg.get("params").cloned().unwrap_or(json!({}));

            // (json-rpc error code, message) on failure; -32601 for unknown methods,
            // -32602 for invalid params such as an unknown prompt.
            let outcome: Result<Value, (i64, String)> = match method {
                "initialize" => Ok(self.initialize(&params)),
                "ping" => Ok(json!({})),
                "tools/list" => Ok(json!({ "tools": self.tool_definitions() })),
                "tools/call" => self.call_tool(&params).await.map_err(|m| (-32601, m)),
                "prompts/list" => Ok(self.prompts_list()),
                "prompts/get" => self.prompts_get(&params),
                other => Err((-32601, format!("Method not found: {other}"))),
            };

            Some(match outcome {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": code, "message": message }
                }),
            })
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("2025-06-18");
        json!({
            "protocolVersion": requested,
            "capabilities": { "tools": {}, "prompts": {} },
            "instructions": knowledge::instructions(&self.knowledge, self.data.stats.total as usize),
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        })
    }

    /// prompts/list: one prompt per task recipe, with its arguments.
    fn prompts_list(&self) -> Value {
        let prompts: Vec<Value> = self
            .knowledge
            .recipes
            .iter()
            .map(|r| {
                json!({
                    "name": r.id,
                    "description": r.description,
                    "arguments": r.args.iter().map(|a| json!({
                        "name": a.name, "description": a.description, "required": a.required
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        json!({ "prompts": prompts })
    }

    /// prompts/get: render a recipe with argument substitution.
    fn prompts_get(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let recipe = self
            .knowledge
            .recipes
            .iter()
            .find(|r| r.id == name)
            .ok_or_else(|| {
                let available: Vec<&str> = self
                    .knowledge
                    .recipes
                    .iter()
                    .map(|r| r.id.as_str())
                    .collect();
                (
                    -32602,
                    format!(
                        "Unknown prompt: {name}. Available: {}",
                        available.join(", ")
                    ),
                )
            })?;
        let mut args = std::collections::HashMap::new();
        if let Some(obj) = params.get("arguments").and_then(Value::as_object) {
            for (k, v) in obj {
                args.insert(k.clone(), stringify_arg(Some(v)));
            }
        }
        Ok(json!({
            "description": recipe.title,
            "messages": [{ "role": "user", "content": { "type": "text", "text": knowledge::render_recipe(recipe, &args) } }],
        }))
    }

    /// The 4 MCP tools with input schemas. Descriptions carry the discovery
    /// workflow and the schema payload knowledge so agents get it at
    /// tools/list time (parity with the TypeScript server's descriptions).
    fn tool_definitions(&self) -> Vec<Value> {
        vec![
            json!({
                "name": "search_apis",
                "description": "Search App Store Connect API operations by keywords (ranked, synonym-aware: 'testflight' finds beta*, 'pricing' finds pricePoint*, 'submit review' finds reviewSubmissions*). Returns matching operation names, methods, paths, and categories, best first. Use this first to find the right operation before calling call_api.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search keywords (e.g. 'review submit', 'beta tester', 'price', 'testflight')" },
                        "category": { "type": "string", "description": "Filter by category. Use list_categories to see all options." },
                        "method": { "type": "string", "enum": ["GET", "POST", "PATCH", "DELETE"], "description": "Filter by HTTP method" }
                    },
                    "required": ["query"]
                }
            }),
            json!({
                "name": "get_tool_details",
                "description": "Get full details of a specific API operation. Returns: all path/query parameters with types and required status; for POST/PATCH the exact JSON:API request body schema (data.type, attributes, relationships with target resource types); the response shape (single vs collection, fields available on the returned resource); and a ready-to-copy example body. ALWAYS call this between search_apis and call_api: it tells you exactly what to pass and what you get back.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "The tool name (operationId), e.g. 'apps_getCollection'" }
                    },
                    "required": ["name"]
                }
            }),
            json!({
                "name": "call_api",
                "description": "Execute any App Store Connect API operation. Workflow: search_apis to find the operation, get_tool_details for the exact body schema and response fields, then call_api. Responses are JSON:API documents: read data[0].id (or data.id) for IDs to chain into subsequent calls, and data[0].attributes for fields.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "The operation name (from search_apis), e.g. 'apps_getCollection'" },
                        "arguments": {
                            "type": "object",
                            "description": "Arguments for the operation. Path params: e.g. {\"id\": \"123456\"}. Query params: e.g. {\"filter[name]\": \"MyApp\", \"limit\": 10}. For POST/PATCH: include \"_body\" with the JSON:API request body - call get_tool_details first for the exact body schema (attributes, relationships and response field names). Optional \"_accept\" overrides the HTTP Accept header for non-JSON endpoints: salesReports/financeReports need \"application/a-gzip\" (gzip report; the Rust build returns metadata only), perfPowerMetrics needs \"*/*\".",
                            "additionalProperties": true
                        }
                    },
                    "required": ["name"]
                }
            }),
            json!({
                "name": "list_categories",
                "description": "List all API categories (resource groups) and total operation count.",
                "inputSchema": { "type": "object", "properties": {} }
            }),
        ]
    }

    /// Route a tools/call request to one of the 4 tools. Returns the MCP
    /// tool result ({content, isError?}) — never a JSON-RPC error, matching
    /// the TypeScript server's behavior of reporting tool failures as
    /// isError content.
    async fn call_tool(&self, params: &Value) -> Result<Value, String> {
        // MCP protocol: params.name is the MCP tool, params.arguments its args
        let name = stringify_arg(params.get("name"));
        let args = params
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        if self.verbose {
            eprintln!("[appstore-connect-mcp] tool call: {name}");
        }

        let text: Result<String, String> = match name.as_str() {
            "search_apis" => self.search_apis(&args),
            "get_tool_details" => self.get_tool_details(&args),
            "call_api" => self.call_api(&args).await,
            "list_categories" => Ok(self.list_categories()),
            other => Err(format!("Unknown tool: {other}")),
        };

        match text {
            Ok(text) => Ok(text_result(text, false)),
            Err(text) => Ok(text_result(text, true)),
        }
    }

    fn search_apis(&self, args: &Map<String, Value>) -> Result<String, String> {
        let query = stringify_arg(args.get("query"));
        let category = args.get("category").and_then(Value::as_str);
        let method = args.get("method").and_then(Value::as_str);

        let matches = self.search.search(&query, category, method);
        let total = matches.len();
        let results: Vec<Value> = matches
            .iter()
            .take(50)
            .map(|t| {
                json!({
                    "name": t.name,
                    "summary": t.summary,
                    "method": t.method,
                    "path": t.path,
                    "category": t.category,
                    "hasBody": t.has_body,
                })
            })
            .collect();
        let related = self.search.related_recipes(&query);
        let hint: Option<String> = if total == 0 {
            Some("No match. Try fewer/other keywords (1-3 words), or list_categories. For a multi-step task use prompts/get.".to_string())
        } else if total > results.len() {
            Some(format!(
                "Top {} of {}; narrow with category/method or more specific keywords.",
                results.len(),
                total
            ))
        } else {
            None
        };
        let mut payload = Map::new();
        payload.insert("query".into(), json!(query));
        payload.insert("totalMatches".into(), json!(total));
        payload.insert("showing".into(), json!(results.len()));
        if !related.is_empty() {
            payload.insert("relatedRecipes".into(), json!(related));
        }
        if let Some(h) = hint {
            payload.insert("hint".into(), json!(h));
        }
        payload.insert("results".into(), Value::Array(results));
        Ok(serde_json::to_string_pretty(&payload).unwrap_or_default())
    }

    fn get_tool_details(&self, args: &Map<String, Value>) -> Result<String, String> {
        let tool_name = stringify_arg(args.get("name"));
        match self.data.tools.iter().find(|t| t.name == tool_name) {
            Some(tool) => {
                // Compact JSON: consumed by an LLM; pretty-printing would
                // nearly double the size for large operations.
                Ok(
                    serde_json::to_string(&tools::tool_details(tool, &self.data))
                        .unwrap_or_default(),
                )
            }
            None => Err(format!("Tool not found: {tool_name}")),
        }
    }

    async fn call_api(&self, args: &Map<String, Value>) -> Result<String, String> {
        let op_name = stringify_arg(args.get("name"));
        let op_args = args
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        let tool = match self.data.tools.iter().find(|t| t.name == op_name) {
            Some(t) => t,
            None => {
                return Err(format!(
                    "Unknown operation: {op_name}. Use search_apis to find available operations."
                ));
            }
        };

        // executeTool: separate path params, query params, and _body
        let mut path_params: BTreeMap<String, String> = BTreeMap::new();
        for p in &tool.path_params {
            if let Some(v) = op_args.get(&p.name) {
                path_params.insert(p.name.clone(), stringify_arg(Some(v)));
            }
        }
        let mut query_params: BTreeMap<String, Value> = BTreeMap::new();
        for p in &tool.query_params {
            if let Some(v) = op_args.get(&p.name) {
                if v.is_null() {
                    continue;
                }
                query_params.insert(p.name.clone(), v.clone());
            }
        }
        let body = if tool.has_body {
            op_args.get("_body")
        } else {
            None
        };
        // Optional per-call Accept override (report endpoints return gzip).
        let accept = op_args
            .get("_accept")
            .and_then(Value::as_str)
            .map(str::to_string);

        let result = client::call_api(
            &self.http,
            &self.tokens,
            &self.creds,
            &tool.method,
            &tool.path,
            &path_params,
            &query_params,
            body,
            accept.as_deref(),
        )
        .await;

        match result {
            Ok(v) => {
                let text = match v {
                    Value::String(s) => s,
                    other => serde_json::to_string_pretty(&other).unwrap_or_default(),
                };
                // Never truncate binary payloads (metadata only here, base64 in TS).
                if text.contains("\"_binary\"") {
                    return Ok(text);
                }
                if text.len() > MAX_RESPONSE_BYTES {
                    let overflow = text.len() - MAX_RESPONSE_BYTES;
                    Ok(format!(
                        "{}\n\n... (truncated, {overflow} more bytes)",
                        &text[..MAX_RESPONSE_BYTES]
                    ))
                } else {
                    Ok(text)
                }
            }
            Err(e) => Err(format!("API Error: {e}")),
        }
    }

    fn list_categories(&self) -> String {
        let payload = json!({
            "apiVersion": self.data.api_version,
            "totalTools": self.data.stats.total,
            "totalCategories": self.data.categories.len(),
            "byMethod": self.data.stats.by_method,
            "categories": self.data.categories,
        });
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    }
}

fn text_result(text: String, is_error: bool) -> Value {
    let mut obj = Map::new();
    obj.insert("content".into(), json!([{ "type": "text", "text": text }]));
    if is_error {
        obj.insert("isError".into(), json!(true));
    }
    Value::Object(obj)
}

fn stringify_arg(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Stdio transport: newline-delimited JSON-RPC on stdin/stdout.
pub async fn run_stdio(mcp: Arc<Mcp>) {
    eprintln!("[appstore-connect-mcp] stdio transport ready");
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(msg) => {
                if let Some(resp) = mcp.handle_message(&msg).await {
                    let mut rendered = serde_json::to_string(&resp).unwrap_or_default();
                    rendered.push('\n');
                    if stdout.write_all(rendered.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdout.flush().await;
                }
            }
            Err(_) => {
                let resp = json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": { "code": -32700, "message": "Parse error" }
                });
                let mut rendered = serde_json::to_string(&resp).unwrap_or_default();
                rendered.push('\n');
                let _ = stdout.write_all(rendered.as_bytes()).await;
                let _ = stdout.flush().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::parse_private_key;

    fn mcp() -> Mcp {
        Mcp::new(
            Credentials {
                issuer_id: "t".into(),
                key_id: "t".into(),
                private_key: parse_private_key("Zm9v"),
            },
            false,
        )
    }

    #[tokio::test]
    async fn initialize_echoes_protocol_version() {
        let m = mcp();
        let msg = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {} }
        });
        let resp = m.handle_message(&msg).await.unwrap();
        assert_eq!(
            resp.pointer("/result/protocolVersion").unwrap(),
            "2025-06-18"
        );
        assert_eq!(
            resp.pointer("/result/serverInfo/name").unwrap(),
            SERVER_NAME
        );
        assert!(resp.pointer("/result/capabilities/tools").is_some());
        assert!(resp.pointer("/result/capabilities/prompts").is_some());
        let instructions = resp
            .pointer("/result/instructions")
            .and_then(Value::as_str)
            .unwrap();
        assert!(instructions.contains("prompts/get"));
        assert!(instructions.contains("submit-for-review"));
    }

    #[tokio::test]
    async fn prompts_list_and_get_serve_recipes() {
        let m = mcp();
        let list = m
            .handle_message(
                &json!({ "jsonrpc": "2.0", "id": 10, "method": "prompts/list", "params": {} }),
            )
            .await
            .unwrap();
        let prompts = list
            .pointer("/result/prompts")
            .and_then(Value::as_array)
            .unwrap();
        assert!(prompts.len() >= 18);
        assert!(
            prompts
                .iter()
                .any(|p| p.get("name").and_then(Value::as_str) == Some("submit-for-review"))
        );

        let get = m
            .handle_message(&json!({
                "jsonrpc": "2.0", "id": 11, "method": "prompts/get",
                "params": { "name": "submit-for-review", "arguments": { "app_id": "123456789" } }
            }))
            .await
            .unwrap();
        let text = get
            .pointer("/result/messages/0/content/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(text.contains("path id=123456789"));
        assert!(text.contains("reviewSubmissions_createInstance"));

        let missing = m
            .handle_message(&json!({ "jsonrpc": "2.0", "id": 12, "method": "prompts/get", "params": { "name": "nope" } }))
            .await
            .unwrap();
        assert_eq!(
            missing.pointer("/error/code").and_then(Value::as_i64),
            Some(-32602)
        );
    }

    #[tokio::test]
    async fn search_apis_ranks_natural_language_and_hints_recipes() {
        let m = mcp();
        let resp = m
            .handle_message(&json!({
                "jsonrpc": "2.0", "id": 13, "method": "tools/call",
                "params": { "name": "search_apis", "arguments": { "query": "submit app for review" } }
            }))
            .await
            .unwrap();
        let text = resp
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        assert!(
            payload
                .pointer("/totalMatches")
                .and_then(Value::as_u64)
                .unwrap()
                > 0
        );
        assert_eq!(
            payload.pointer("/results/0/name").and_then(Value::as_str),
            Some("reviewSubmissions_createInstance")
        );
        let related = payload
            .get("relatedRecipes")
            .and_then(Value::as_array)
            .unwrap();
        assert!(related.iter().any(|r| r == "submit-for-review"));
    }

    #[tokio::test]
    async fn tools_list_exposes_exactly_four_tools_with_workflow_descriptions() {
        let m = mcp();
        let msg = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
        let resp = m.handle_message(&msg).await.unwrap();
        let tools = resp
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(tools.len(), 4);
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t.get("name").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "search_apis",
                "get_tool_details",
                "call_api",
                "list_categories"
            ]
        );
        let details_desc = tools[1].get("description").and_then(Value::as_str).unwrap();
        assert!(details_desc.contains("JSON:API request body schema"));
        assert!(details_desc.contains("ALWAYS call this"));
    }

    #[tokio::test]
    async fn notification_gets_no_response() {
        let m = mcp();
        let msg = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(m.handle_message(&msg).await.is_none());
    }

    #[tokio::test]
    async fn unknown_method_returns_procedure_error() {
        let m = mcp();
        let msg = json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {} });
        let resp = m.handle_message(&msg).await.unwrap();
        assert_eq!(resp.pointer("/error/code").unwrap(), -32601);
    }

    #[tokio::test]
    async fn get_tool_details_returns_schemas_and_unknown_reports_error() {
        let m = mcp();
        let msg = json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "get_tool_details", "arguments": { "name": "accessibilityDeclarations_createInstance" } }
        });
        let resp = m.handle_message(&msg).await.unwrap();
        assert!(
            resp.pointer("/result/isError").is_none(),
            "found tool must not be isError"
        );
        let text = resp
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        let parsed: Value = serde_json::from_str(text).expect("details must be valid JSON");
        assert!(parsed.get("bodySchema").is_some());
        assert!(parsed.get("responseSchema").is_some());
        assert!(parsed.pointer("/example/_body").is_some());

        let msg2 = json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "get_tool_details", "arguments": { "name": "nope_missing" } }
        });
        let resp2 = m.handle_message(&msg2).await.unwrap();
        assert_eq!(resp2.pointer("/result/isError").unwrap(), true);
        assert!(
            resp2
                .pointer("/result/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .starts_with("Tool not found:")
        );
    }

    #[tokio::test]
    async fn call_api_unknown_operation_reports_error() {
        let m = mcp();
        let msg = json!({
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": { "name": "call_api", "arguments": { "name": "bogus_op" } }
        });
        let resp = m.handle_message(&msg).await.unwrap();
        let text = resp
            .pointer("/result/content/0/text")
            .unwrap()
            .as_str()
            .unwrap();
        assert!(text.starts_with("Unknown operation: bogus_op"));
    }

    #[tokio::test]
    async fn list_categories_reports_totals() {
        let m = mcp();
        let msg = json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "list_categories" }
        });
        let resp = m.handle_message(&msg).await.unwrap();
        let text = resp
            .pointer("/result/content/0/text")
            .unwrap()
            .as_str()
            .unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["totalTools"], m.data.stats.total);
        assert_eq!(parsed["apiVersion"], m.data.api_version);
    }
}
