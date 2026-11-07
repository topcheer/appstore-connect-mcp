//! client.rs — HTTP client for the App Store Connect REST API.
//!
//! Mirrors src/client.ts: JWT auth, JSON:API conventions, error
//! normalisation, 204/empty-body handling.

use crate::auth::TokenCache;
use crate::types::Credentials;
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use reqwest::Url;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use thiserror::Error;

const BASE_URL: &str = "https://api.appstoreconnect.apple.com";

/// Matches JavaScript `encodeURIComponent`: everything except
/// A-Z a-z 0-9 - _ . ! ~ * ' ( )
const ENCODE_COMPONENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

/// Pure URL builder (unit-testable): substitute path params, append query params.
/// Query arrays become repeated keys; empty-string/null values are skipped,
/// matching the TypeScript client.
pub fn build_url(
    path: &str,
    path_params: &BTreeMap<String, String>,
    query_params: &BTreeMap<String, Value>,
) -> Url {
    let mut url_str = path.to_string();
    for (key, value) in path_params.iter() {
        let encoded = utf8_percent_encode(value, ENCODE_COMPONENT).to_string();
        url_str = url_str.replace(&format!("{{{key}}}"), &encoded);
    }

    let mut url = Url::parse(BASE_URL)
        .expect("BASE_URL is a valid URL")
        .join(&url_str)
        .expect("joined URL is valid");
    if !query_params.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query_params.iter() {
            match value {
                Value::Null => {}
                Value::String(s) if s.is_empty() => {}
                Value::Array(items) => {
                    for item in items {
                        if !item.is_null() {
                            pairs.append_pair(key, &value_to_string(item));
                        }
                    }
                }
                other => {
                    pairs.append_pair(key, &value_to_string(other));
                }
            }
        }
    }
    url
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Execute a single App Store Connect API request.
#[allow(clippy::too_many_arguments)] // mirrors the TypeScript client's ApiRequestOptions shape
///
/// Returns the parsed JSON response (or `{status, message}` for 204/empty),
/// mirroring the TypeScript client's contract.
pub async fn call_api(
    http: &reqwest::Client,
    tokens: &TokenCache,
    creds: &Credentials,
    method: &str,
    path: &str,
    path_params: &BTreeMap<String, String>,
    query_params: &BTreeMap<String, Value>,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let url = build_url(path, path_params, query_params);
    let token = tokens.get_token(creds, false).map_err(|e| ApiError {
        status: 0,
        message: e.to_string(),
    })?;

    let send_body = body.is_some() && method != "GET" && method != "DELETE";
    let mut req = http
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| ApiError {
                status: 0,
                message: format!("invalid method: {e}"),
            })?,
            url.clone(),
        )
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json");
    if send_body {
        req = req
            .header("Content-Type", "application/json")
            .json(body.unwrap());
    }

    let response = req.send().await.map_err(|e| ApiError {
        status: 0,
        message: format!("request failed: {e}"),
    })?;
    let status = response.status().as_u16();
    let response_text = response.text().await.map_err(|e| ApiError {
        status,
        message: format!("failed to read response: {e}"),
    })?;

    if !(200..300).contains(&status) {
        let detail: Value =
            serde_json::from_str(&response_text).unwrap_or(Value::String(response_text.clone()));
        return Err(ApiError {
            status,
            message: api_error_message(status, &detail),
        });
    }

    if status == 204 || response_text.is_empty() {
        return Ok(json!({ "status": status, "message": "Success (no content)" }));
    }

    match serde_json::from_str::<Value>(&response_text) {
        Ok(v) => Ok(v),
        Err(_) => Ok(Value::String(response_text)),
    }
}

/// Error message format matching ApiError in client.ts.
fn api_error_message(status: u16, detail: &Value) -> String {
    if detail.as_object().is_some_and(|o| o.contains_key("errors")) {
        serde_json::to_string_pretty(&detail["errors"]).unwrap_or_default()
    } else {
        let rendered = match detail {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let cut = rendered
            .char_indices()
            .nth(200)
            .map(|(i, _)| i)
            .unwrap_or(rendered.len());
        format!("HTTP {status}: {}", &rendered[..cut])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(entries: &[(&str, Value)]) -> BTreeMap<String, Value> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn substitutes_path_params_and_encodes_them() {
        let mut path_params = BTreeMap::new();
        path_params.insert("id".to_string(), "abc 123/456".to_string());
        let url = build_url("/v1/apps/{id}", &path_params, &BTreeMap::new());
        assert_eq!(
            url.as_str(),
            "https://api.appstoreconnect.apple.com/v1/apps/abc%20123%2F456"
        );
    }

    #[test]
    fn appends_repeated_array_query_params_and_skips_empties() {
        let qp = map(&[
            ("filter[name]", json!("MyApp")),
            ("include", json!(["builds", "betaTesters"])),
            ("empty", json!("")),
            ("null", Value::Null),
            ("limit", json!(10)),
        ]);
        let url = build_url("/v1/apps", &BTreeMap::new(), &qp);
        let rendered = url.as_str();
        assert!(
            rendered.contains("filter%5Bname%5D=MyApp"),
            "bracket key must be form-encoded: {rendered}"
        );
        assert_eq!(url.query_pairs().filter(|(k, _)| k == "include").count(), 2);
        assert!(!rendered.contains("empty="), "empty string must be skipped");
        assert!(rendered.contains("limit=10"));
    }

    #[test]
    fn api_error_message_prefers_errors_array() {
        let detail = json!({ "errors": [{ "status": "404", "title": "Not Found" }] });
        let msg = api_error_message(404, &detail);
        assert!(msg.contains("Not Found"));

        let msg2 = api_error_message(502, &json!("Bad Gateway"));
        assert_eq!(msg2, "HTTP 502: Bad Gateway");
    }
}
