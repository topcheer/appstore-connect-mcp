//! appstore-connect-mcp (Rust port)
//!
//! Usage:
//!   # Local (stdio) - for Claude Desktop, Cursor, etc.
//!   appstore-connect-mcp
//!   appstore-connect-mcp --transport stdio
//!
//!   # Remote (HTTP) - for server deployment
//!   appstore-connect-mcp --transport http --port 3000 --host 0.0.0.0
//!
//! Environment variables (same names as the TypeScript server):
//!   APP_STORE_CONNECT_ISSUER_ID    App Store Connect issuer ID
//!   APP_STORE_CONNECT_KEY_ID       API key ID
//!   APP_STORE_CONNECT_PRIVATE_KEY  PEM private key content (alternative: path)
//!   APP_STORE_CONNECT_P8_FILE      Path to your .p8 private key file
//!   MCP_TRANSPORT                  'stdio' (default) or 'http'
//!   MCP_PORT                       HTTP port (default: 3000)
//!   MCP_HOST                       HTTP host (default: 0.0.0.0)
//!   MCP_VERBOSE                    Set to '1' for verbose logging

mod auth;
mod client;
mod data;
mod http;
mod mcp;
mod tools;
mod types;

use clap::Parser;
use types::{Credentials, ServerConfig, Transport};

#[derive(Parser, Debug)]
#[command(
    name = "appstore-connect-mcp",
    version,
    about = "App Store Connect MCP server exposing the full ASC API via 4 tools"
)]
struct Args {
    /// Transport: stdio (default) or http
    #[arg(long)]
    transport: Option<String>,

    /// HTTP port (default 3000)
    #[arg(long)]
    port: Option<u16>,

    /// HTTP host (default 0.0.0.0)
    #[arg(long)]
    host: Option<String>,

    /// App Store Connect issuer ID
    #[arg(long)]
    issuer_id: Option<String>,

    /// App Store Connect API key ID
    #[arg(long)]
    key_id: Option<String>,

    /// Path to the .p8 private key file
    #[arg(long)]
    p8_file: Option<String>,

    /// Verbose logging to stderr
    #[arg(long)]
    verbose: bool,
}

fn load_config() -> Result<ServerConfig, String> {
    let args = Args::parse();

    let transport = match args
        .transport
        .or_else(|| std::env::var("MCP_TRANSPORT").ok())
        .unwrap_or_else(|| "stdio".to_string())
        .to_lowercase()
        .as_str()
    {
        "stdio" => Transport::Stdio,
        "http" => Transport::Http,
        other => {
            return Err(format!(
                "invalid transport '{other}': expected 'stdio' or 'http'"
            ));
        }
    };

    let issuer_id = args
        .issuer_id
        .or_else(|| std::env::var("APP_STORE_CONNECT_ISSUER_ID").ok())
        .unwrap_or_default();

    let key_id = args
        .key_id
        .or_else(|| std::env::var("APP_STORE_CONNECT_KEY_ID").ok())
        .unwrap_or_default();

    // Private key: env var content, then .p8 file path, then legacy env names
    let mut private_key = std::env::var("APP_STORE_CONNECT_PRIVATE_KEY").unwrap_or_default();
    let p8_file = args
        .p8_file
        .or_else(|| std::env::var("APP_STORE_CONNECT_P8_FILE").ok())
        .unwrap_or_default();
    if private_key.is_empty() && !p8_file.is_empty() {
        private_key = std::fs::read_to_string(&p8_file)
            .map_err(|e| format!("failed to read p8 file {p8_file}: {e}"))?;
    }
    if private_key.is_empty() {
        private_key = std::env::var("ASC_PRIVATE_KEY")
            .or_else(|_| std::env::var("APPSTORE_CONNECT_PRIVATE_KEY"))
            .unwrap_or_default();
    }

    let credentials = Credentials {
        issuer_id,
        key_id,
        private_key: if private_key.is_empty() {
            String::new()
        } else {
            auth::parse_private_key(&private_key)
        },
    };

    let verbose = args.verbose || std::env::var("MCP_VERBOSE").as_deref() == Ok("1");

    let port = args
        .port
        .or_else(|| {
            std::env::var("MCP_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
        })
        .unwrap_or(3000);
    let host = args
        .host
        .or_else(|| std::env::var("MCP_HOST").ok())
        .unwrap_or_else(|| "0.0.0.0".to_string());

    Ok(ServerConfig {
        credentials,
        transport,
        port,
        host,
        verbose,
    })
}

fn die(msg: &str) -> ! {
    eprintln!("Error: {msg}");
    eprintln!("\nSee https://github.com/topcheer/appstore-connect-mcp#setup for help.");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => die(&e),
    };

    if let Err(e) = auth::validate_credentials(&config.credentials) {
        die(&e);
    }

    // Verify the key works by generating a test token
    let cache = auth::TokenCache::default();
    if let Err(e) = cache.get_token(&config.credentials, false) {
        die(&format!("{e}"));
    }

    if config.verbose {
        let mode = match config.transport {
            Transport::Stdio => "stdio",
            Transport::Http => "http",
        };
        eprintln!("[appstore-connect-mcp] Starting in {mode} mode");
    }

    let mcp = std::sync::Arc::new(mcp::Mcp::new(config.credentials.clone(), config.verbose));

    match config.transport {
        Transport::Http => {
            if let Err(e) = http::run_http(mcp, &config.host, config.port).await {
                eprintln!("Fatal error: {e}");
                std::process::exit(1);
            }
        }
        Transport::Stdio => mcp::run_stdio(mcp).await,
    }
}
