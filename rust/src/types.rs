//! types.rs — shared configuration types.

use serde::{Deserialize, Serialize};

/// Credentials for the App Store Connect API.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Credentials {
    pub issuer_id: String,
    pub key_id: String,
    /// PEM-formatted ECDSA P-256 private key.
    pub private_key: String,
}

/// Server configuration resolved from CLI flags + environment.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub credentials: Credentials,
    pub transport: Transport,
    pub port: u16,
    pub host: String,
    pub verbose: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Stdio,
    Http,
}
