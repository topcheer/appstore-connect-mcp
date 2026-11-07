//! auth.rs — ES256 JWT generation for the App Store Connect API.
//!
//! Mirrors src/auth.ts: ES256 (ECDSA P-256 + SHA-256), 20-minute TTL
//! (Apple maximum), in-memory cache refreshed when <60s of life remains.

use crate::types::Credentials;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::json;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const AUDIENCE: &str = "appstoreconnect-v1";
const TOKEN_TTL_SECONDS: u64 = 20 * 60; // 20 minutes (Apple allows max 20)

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Failed to sign JWT - invalid private key: {0}")]
    Sign(String),
}

/// Cached token to avoid re-signing on every request.
pub struct TokenCache {
    inner: Mutex<Option<(String, u64)>>,
}

impl Default for TokenCache {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl TokenCache {
    /// Generate (or return cached) a signed JWT for the App Store Connect API.
    pub fn get_token(&self, creds: &Credentials, force: bool) -> Result<String, AuthError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if !force {
            let cached = self.inner.lock().unwrap();
            if let Some((token, expiry)) = cached.as_ref()
                && now < expiry.saturating_sub(60)
            {
                return Ok(token.clone());
            }
        }

        let token = sign_token(creds, now)?;
        *self.inner.lock().unwrap() = Some((token.clone(), now + TOKEN_TTL_SECONDS));
        Ok(token)
    }
}

/// Sign a fresh JWT: header carries ES256 alg + kid, payload is the Apple claims set.
fn sign_token(creds: &Credentials, now: u64) -> Result<String, AuthError> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(creds.key_id.clone());
    header.typ = Some("JWT".to_string());

    let claims = json!({
        "iss": creds.issuer_id,
        "iat": now,
        "exp": now + TOKEN_TTL_SECONDS,
        "aud": AUDIENCE,
    });

    let key = EncodingKey::from_ec_pem(creds.private_key.as_bytes())
        .map_err(|e| AuthError::Sign(e.to_string()))?;
    jsonwebtoken::encode(&header, &claims, &key).map_err(|e| AuthError::Sign(e.to_string()))
}

/// Parse a .p8 file content into a PEM string suitable for signing.
/// Handles both raw PEM and the Apple AuthKey format.
pub fn parse_private_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.contains("-----BEGIN PRIVATE KEY-----") || trimmed.contains("-----BEGIN") {
        return trimmed.to_string();
    }
    format!("-----BEGIN PRIVATE KEY-----\n{trimmed}\n-----END PRIVATE KEY-----")
}

/// Validate that credentials look reasonable. Returns an error message
/// matching the TypeScript server's wording.
pub fn validate_credentials(creds: &Credentials) -> Result<(), String> {
    if creds.issuer_id.is_empty() {
        return Err("Missing APP_STORE_CONNECT_ISSUER_ID. Set it via env or CLI flag.".into());
    }
    if creds.key_id.is_empty() {
        return Err("Missing APP_STORE_CONNECT_KEY_ID. Set it via env or CLI flag.".into());
    }
    if creds.private_key.is_empty() {
        return Err(
            "Missing APP_STORE_CONNECT_PRIVATE_KEY. Provide the .p8 file path via APP_STORE_CONNECT_P8_FILE or the key content via the env var."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Credentials;
    use jsonwebtoken::{DecodingKey, Validation};

    const TEST_KEY: &str = include_str!("../tests/fixtures/test_key.pem");
    const TEST_PUB: &str = include_str!("../tests/fixtures/test_key_pub.pem");

    fn creds() -> Credentials {
        Credentials {
            issuer_id: "test-issuer".into(),
            key_id: "test-key-id".into(),
            private_key: TEST_KEY.into(),
        }
    }

    #[test]
    fn signs_and_verifies_es256_jwt() {
        let cache = TokenCache::default();
        let token = cache.get_token(&creds(), false).expect("sign failed");
        let segments: Vec<&str> = token.split('.').collect();
        assert_eq!(segments.len(), 3, "JWT must have 3 segments");

        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_audience(&[AUDIENCE]);
        validation.leeway = 60;
        let claims = jsonwebtoken::decode::<serde_json::Value>(
            &token,
            &DecodingKey::from_ec_pem(TEST_PUB.as_bytes()).unwrap(),
            &validation,
        )
        .expect("token must verify against public key");
        assert_eq!(claims.claims["iss"], "test-issuer");
        assert_eq!(claims.claims["aud"], AUDIENCE);
        assert_eq!(claims.header.kid.as_deref(), Some("test-key-id"));
    }

    #[test]
    fn caches_token_within_ttl() {
        let cache = TokenCache::default();
        let a = cache.get_token(&creds(), false).unwrap();
        let b = cache.get_token(&creds(), false).unwrap();
        assert_eq!(a, b, "second call within TTL must reuse the cache");
    }

    #[test]
    fn parse_private_key_wraps_raw_base64() {
        assert_eq!(
            parse_private_key("  -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"),
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
        );
        assert_eq!(
            parse_private_key("Zm9v"),
            "-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----"
        );
    }

    #[test]
    fn validate_reports_each_missing_field() {
        let e = Credentials::default();
        assert!(validate_credentials(&e).unwrap_err().contains("ISSUER_ID"));
        let mut c = e.clone();
        c.issuer_id = "x".into();
        assert!(validate_credentials(&c).unwrap_err().contains("KEY_ID"));
        c.key_id = "y".into();
        assert!(
            validate_credentials(&c)
                .unwrap_err()
                .contains("PRIVATE_KEY")
        );
        c.private_key = "z".into();
        assert!(validate_credentials(&c).is_ok());
    }
}
