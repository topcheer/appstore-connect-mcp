//! http.rs - Streamable HTTP transport for remote deployment.
//!
//! Mirrors src/transport.ts: POST /mcp (JSON request/response), DELETE /mcp
//! (session termination), GET /health. Each client session is tracked via the
//! `mcp-session-id` header (issued on initialize).
//!
//! Divergence from the TypeScript SDK transport: GET /mcp (server-initiated
//! SSE stream) is not implemented - it responds 405, which the MCP Streamable
//! HTTP spec permits for servers without server-to-client streams.

use crate::mcp::Mcp;
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

struct HttpState {
    mcp: Arc<Mcp>,
    sessions: RwLock<HashSet<String>>,
}

pub async fn run_http(mcp: Arc<Mcp>, host: &str, port: u16) -> Result<(), String> {
    let state = Arc::new(HttpState {
        mcp,
        sessions: RwLock::new(HashSet::new()),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp_post).get(mcp_get).delete(mcp_delete))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024)) // parity: express.json limit 50mb
        .with_state(state);

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind {addr}: {e}"))?;
    eprintln!("[appstore-connect-mcp] HTTP transport ready on http://{addr}/mcp");
    eprintln!("[appstore-connect-mcp] Health check at http://{addr}/health");
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("server error: {e}"))
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "server": crate::mcp::SERVER_NAME,
        "version": crate::mcp::SERVER_VERSION,
    }))
}

fn session_id_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

fn session_exists(state: &HttpState, sid: Option<&String>) -> bool {
    match sid {
        Some(sid) => state.sessions.read().unwrap().contains(sid),
        None => false,
    }
}

async fn mcp_post(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    // Parity with the SDK transport: reject requests that cannot accept our
    // JSON responses.
    let accept = headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !accept.contains("application/json") && !accept.contains("text/event-stream") {
        return (
            StatusCode::NOT_ACCEPTABLE,
            Json(json!({
                "error": "Not Acceptable: Client must include Accept: application/json, text/event-stream"
            })),
        )
            .into_response();
    }

    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Parse error: {e}") })),
            )
                .into_response();
        }
    };

    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let sid = session_id_from(&headers);

    if sid.is_some() && !session_exists(&state, sid.as_ref()) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Session not found" })),
        )
            .into_response();
    }
    if sid.is_none() && method != "initialize" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No valid session. Send an initialize request first." })),
        )
            .into_response();
    }

    let response = state.mcp.handle_message(&msg).await;

    let new_session = if sid.is_none() {
        let new_sid = uuid::Uuid::new_v4().to_string();
        state.sessions.write().unwrap().insert(new_sid.clone());
        Some(new_sid)
    } else {
        None
    };

    let mut resp = match response {
        Some(v) => Json(v).into_response(),
        // All notifications: accept but no body (MCP spec: 202 Accepted)
        None => StatusCode::ACCEPTED.into_response(),
    };
    if let Some(new_sid) = new_session
        && let Ok(hv) = axum::http::HeaderValue::from_str(&new_sid)
    {
        resp.headers_mut().insert("mcp-session-id", hv);
    }
    resp
}

async fn mcp_get(State(state): State<Arc<HttpState>>, headers: HeaderMap) -> Response {
    let sid = session_id_from(&headers);
    if !session_exists(&state, sid.as_ref()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No valid session. Send an initialize request first." })),
        )
            .into_response();
    }
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({
            "error": "Method Not Allowed: server-initiated SSE streams are not supported; use POST /mcp"
        })),
    )
        .into_response()
}

async fn mcp_delete(State(state): State<Arc<HttpState>>, headers: HeaderMap) -> Response {
    let sid = session_id_from(&headers);
    match sid {
        Some(sid) if session_exists(&state, Some(&sid)) => {
            state.sessions.write().unwrap().remove(&sid);
            StatusCode::OK.into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "No valid session." })),
        )
            .into_response(),
    }
}
