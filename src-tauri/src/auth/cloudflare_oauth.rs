//! Cloudflare OAuth 2.0 (Authorization Code + PKCE).
//!
//! This mirrors Wrangler's login behavior:
//! - auth:   https://dash.cloudflare.com/oauth2/auth
//! - token:  https://dash.cloudflare.com/oauth2/token
//! - revoke: https://dash.cloudflare.com/oauth2/revoke
//! - client: 54d11594-84e4-41aa-b438-e81b8fa78ee7
//! - redirect URI: http://localhost:8976/oauth/callback

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_oauth::{start_with_config, OauthConfig};
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::commands::CloudflareOauth;

pub const CF_OAUTH_AUTH_URL: &str = "https://dash.cloudflare.com/oauth2/auth";
pub const CF_OAUTH_TOKEN_URL: &str = "https://dash.cloudflare.com/oauth2/token";
pub const CF_OAUTH_REVOKE_URL: &str = "https://dash.cloudflare.com/oauth2/revoke";
pub const CF_CLIENT_ID: &str = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
pub const CF_CALLBACK_PORT: u16 = 8976;
pub const CF_REDIRECT_URI: &str = "http://localhost:8976/oauth/callback";
pub const CF_SCOPES: &str = "account:read user:read workers:write \
workers_kv:write workers_scripts:write \
offline_access";
const AUTH_TIMEOUT_SECS: u64 = 300;

const CALLBACK_HTML: &str = r#"<!DOCTYPE html>
<html><head><title>amusic — connected</title><meta charset="utf-8"><style>
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
  <h1>Cloudflare connected</h1>
  <p>You can close this tab and return to amusic.</p>
</div>
</body></html>"#;

type CallbackResult = Result<(String, String), String>;
static SLOT: OnceLock<Mutex<Option<oneshot::Sender<CallbackResult>>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<oneshot::Sender<CallbackResult>>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

pub fn generate_pkce() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);

    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let digest = hasher.finalize();
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);

    (code_verifier, code_challenge)
}

pub fn generate_state() -> String {
    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(state_bytes)
}

pub async fn start_oauth_flow(_app: &AppHandle) -> Result<CloudflareOauth> {
    let _ = cancel_oauth_flow().await;

    let (code_verifier, code_challenge) = generate_pkce();
    let state = generate_state();

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    *slot().lock().await = Some(tx);

    let config = OauthConfig {
        ports: Some(vec![CF_CALLBACK_PORT]),
        response: Some(CALLBACK_HTML.into()),
    };

    start_with_config(config, |url: String| {
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

        let code = parsed
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        let state = parsed
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned());
        let error = parsed
            .query_pairs()
            .find(|(k, _)| k == "error")
            .map(|(_, v)| v.into_owned());
        let error_description = parsed
            .query_pairs()
            .find(|(k, _)| k == "error_description")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        let path = parsed.path().to_string();

        tauri::async_runtime::spawn(async move {
            if let Some(sender) = slot().lock().await.take() {
                if path != "/oauth/callback" {
                    let _ = sender.send(Err(format!("Unexpected callback path: {path}")));
                    return;
                }

                if let Some(err) = error {
                    let message = if error_description.is_empty() {
                        format!("Cloudflare OAuth failed: {err}")
                    } else {
                        format!("Cloudflare OAuth failed: {err} ({error_description})")
                    };
                    let _ = sender.send(Err(message));
                    return;
                }

                let _ = match (code, state) {
                    (Some(c), Some(s)) => sender.send(Ok((c, s))),
                    _ => sender.send(Err(
                        "Cloudflare redirected without a code/state. OAuth was not completed."
                            .to_string(),
                    )),
                };
            }
        });
    })
    .map_err(|e| anyhow!("Failed to start Cloudflare OAuth listener: {}", e))?;

    let mut auth_url = Url::parse(CF_OAUTH_AUTH_URL)
        .map_err(|e| anyhow!("Failed to parse Cloudflare auth URL: {}", e))?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CF_CLIENT_ID)
        .append_pair("redirect_uri", CF_REDIRECT_URI)
        .append_pair("scope", CF_SCOPES)
        .append_pair("state", &state)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256");

    open::that(auth_url.to_string())
        .map_err(|e| anyhow!("Failed to open browser: {}", e))?;

    let (code, callback_state) = tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), rx)
        .await
        .map_err(|_| anyhow!("Cloudflare OAuth timed out after 5 minutes"))?
        .map_err(|_| anyhow!("Cloudflare OAuth was cancelled"))?
        .map_err(|e| anyhow!("{}", e))?;

    if callback_state != state {
        return Err(anyhow!(
            "Cloudflare OAuth state mismatch. Please retry login."
        ));
    }

    exchange_authorization_code(&code, &code_verifier).await
}

async fn exchange_authorization_code(code: &str, code_verifier: &str) -> Result<CloudflareOauth> {
    let client = reqwest::Client::new();
    let resp = client
        .post(CF_OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", CF_REDIRECT_URI),
            ("client_id", CF_CLIENT_ID),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| anyhow!("Cloudflare OAuth token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Cloudflare OAuth token exchange returned {}: {}",
            status,
            body
        ));
    }

    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Cloudflare OAuth response: {}", e))?;

    let expires_at = chrono::Utc::now().timestamp() + parsed.expires_in.unwrap_or(14400);
    Ok(CloudflareOauth {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        expires_at,
        scope: parsed.scope.unwrap_or_default(),
    })
}

pub async fn refresh_access_token(refresh_token: &str) -> Result<CloudflareOauth> {
    let client = reqwest::Client::new();
    let resp = client
        .post(CF_OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CF_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| anyhow!("Cloudflare OAuth refresh failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Cloudflare OAuth refresh returned {}: {}",
            status,
            body
        ));
    }

    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Cloudflare refresh response: {}", e))?;

    let expires_at = chrono::Utc::now().timestamp() + parsed.expires_in.unwrap_or(14400);
    Ok(CloudflareOauth {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at,
        scope: parsed.scope.unwrap_or_default(),
    })
}

pub async fn revoke_token(token: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post(CF_OAUTH_REVOKE_URL)
        .form(&[("token", token)])
        .send()
        .await;

    match resp {
        Ok(r) if !r.status().is_success() => {
            log::warn!("Cloudflare OAuth revoke returned HTTP {}", r.status());
        }
        Err(e) => {
            log::warn!("Cloudflare OAuth revoke request failed: {}", e);
        }
        Ok(_) => {}
    }

    Ok(())
}

pub async fn cancel_oauth_flow() -> Result<()> {
    if let Some(sender) = slot().lock().await.take() {
        let _ = sender.send(Err("cancelled".to_string()));
    }
    Ok(())
}
