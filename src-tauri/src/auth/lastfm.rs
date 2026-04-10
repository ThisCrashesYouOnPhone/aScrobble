//! Last.fm authentication.
//!
//! Implements the RFC 8252 loopback redirect pattern for native apps:
//!   1. Start a temporary localhost HTTP server on a random free port.
//!   2. Open https://www.last.fm/api/auth/?api_key=X&cb=http://localhost:PORT
//!      in the user's default browser (NOT an embedded webview — better
//!      security posture, lets users reuse existing Last.fm sessions).
//!   3. User clicks "Yes, allow access". Last.fm redirects to our loopback
//!      with a `?token=...` query param.
//!   4. We exchange that temporary token for a permanent session key via
//!      `auth.getSession`, which requires an MD5-signed request.
//!
//! The session key never expires unless the user revokes the app at
//! https://www.last.fm/settings/applications.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use md5::{Digest, Md5};
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_oauth::{start_with_config, OauthConfig};
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::commands::LastfmSession;
use crate::storage;

const LASTFM_AUTH_URL: &str = "https://www.last.fm/api/auth/";
const LASTFM_API_URL: &str = "https://ws.audioscrobbler.com/2.0/";
const AUTH_TIMEOUT_SECS: u64 = 300;

const CALLBACK_HTML: &str = r#"<!DOCTYPE html>
<html><head><title>aScrobble — connected</title><meta charset="utf-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       background: #0f0f10; color: #fff; display: flex; align-items: center;
       justify-content: center; height: 100vh; margin: 0; }
.card { text-align: center; padding: 48px; border-radius: 16px;
        background: #1a1a1c; border: 1px solid #2a2a2d; max-width: 420px; }
.check { font-size: 56px; margin-bottom: 12px; }
h1 { font-size: 22px; margin: 0 0 8px; font-weight: 600; }
p { margin: 0; opacity: 0.6; font-size: 14px; line-height: 1.5; }
</style></head><body>
<div class="card">
  <div class="check">✓</div>
  <h1>Last.fm connected</h1>
  <p>You can close this tab and return to aScrobble.</p>
</div>
</body></html>"#;

type TokenResult = Result<String, String>;

static SLOT: OnceLock<Mutex<Option<oneshot::Sender<TokenResult>>>> = OnceLock::new();
fn slot() -> &'static Mutex<Option<oneshot::Sender<TokenResult>>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    session: SessionInner,
}

#[derive(Debug, Deserialize)]
struct SessionInner {
    name: String,
    key: String,
    #[serde(default)]
    #[allow(dead_code)]
    subscriber: i32,
}

pub async fn start_auth_flow(
    _app: &AppHandle,
    api_key: String,
    shared_secret: String,
) -> Result<LastfmSession> {
    // Cancel any previous in-flight auth
    let _ = cancel_auth_flow().await;

    let (tx, rx) = oneshot::channel::<TokenResult>();
    *slot().lock().await = Some(tx);

    // Start the loopback server
    let config = OauthConfig {
        ports: None, // let the plugin pick any free port
        response: Some(CALLBACK_HTML.into()),
    };

    let port = start_with_config(config, |url: String| {
        // Runs on the plugin's thread when a request hits the loopback
        let parsed = match Url::parse(&url) {
            Ok(u) => u,
            Err(e) => {
                let err = format!("Invalid callback URL: {e}");
                tauri::async_runtime::spawn(async move {
                    if let Some(s) = slot().lock().await.take() {
                        let _ = s.send(Err(err));
                    }
                });
                return;
            }
        };

        let token = parsed
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.into_owned());

        tauri::async_runtime::spawn(async move {
            if let Some(sender) = slot().lock().await.take() {
                let _ = match token {
                    Some(t) => sender.send(Ok(t)),
                    None => sender.send(Err(
                        "Last.fm redirected without a token. Did you click 'Yes, allow access'?"
                            .into(),
                    )),
                };
            }
        });
    })
    .map_err(|e| anyhow!("Failed to start loopback server: {}", e))?;

    // Open Last.fm auth page in the user's default browser
    let auth_url = format!(
        "{}?api_key={}&cb=http://localhost:{}/",
        LASTFM_AUTH_URL, api_key, port
    );
    open::that(&auth_url)
        .map_err(|e| anyhow!("Failed to open browser: {}", e))?;

    // Wait for the callback
    let token = tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), rx)
        .await
        .map_err(|_| anyhow!("Last.fm auth timed out after 5 minutes"))?
        .map_err(|_| anyhow!("Last.fm auth was cancelled"))?
        .map_err(|e| anyhow!("{}", e))?;

    // Exchange the token for a session key
    let session = exchange_token(&api_key, &shared_secret, &token).await?;

    // Persist to keychain
    storage::save_lastfm_session(&session)?;
    let persisted = storage::load_lastfm_session()?
        .ok_or_else(|| anyhow!("Last.fm session was saved but missing on keychain read-back"))?;
    if persisted.session_key != session.session_key {
        return Err(anyhow!(
            "Last.fm session read-back mismatch after keychain save"
        ));
    }

    Ok(session)
}

/// Exchange an authorized token for a permanent session key via auth.getSession.
async fn exchange_token(
    api_key: &str,
    shared_secret: &str,
    token: &str,
) -> Result<LastfmSession> {
    // Signature: MD5(api_key + method + token + secret) per Last.fm spec
    let sig_string = format!(
        "api_key{}methodauth.getSessiontoken{}{}",
        api_key, token, shared_secret
    );
    let mut hasher = Md5::new();
    hasher.update(sig_string.as_bytes());
    let sig = hex::encode(hasher.finalize());

    let client = reqwest::Client::new();
    let resp = client
        .get(LASTFM_API_URL)
        .query(&[
            ("method", "auth.getSession"),
            ("api_key", api_key),
            ("token", token),
            ("api_sig", &sig),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|e| anyhow!("Last.fm request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Last.fm auth.getSession returned {}: {}",
            status,
            body
        ));
    }

    let parsed: SessionResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Last.fm response: {}", e))?;

    Ok(LastfmSession {
        session_key: parsed.session.key,
        username: parsed.session.name,
        api_key: api_key.to_string(),
        shared_secret: shared_secret.to_string(),
    })
}

pub async fn cancel_auth_flow() -> Result<()> {
    if let Some(sender) = slot().lock().await.take() {
        let _ = sender.send(Err("cancelled".to_string()));
    }
    Ok(())
}
