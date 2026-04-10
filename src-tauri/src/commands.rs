//! #[tauri::command] surface for the React frontend.
//!
//! Commands are deliberately small — each one delegates to an auth/* or
//! storage module. The bulky logic lives in those modules so this file
//! stays as a clean API reference for the frontend.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth;
use crate::storage;

// ---------- shared DTOs ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppleTokens {
    pub developer_token: String,
    pub music_user_token: String,
    pub captured_at: String, // ISO-8601
    pub expires_at: Option<String>, // ISO-8601 from JWT exp claim, if decodable
}

impl AppleTokens {
    /// Decode the JWT payload to extract the expiration time
    pub fn with_decoded_expiry(mut self) -> Self {
        self.expires_at = Self::decode_jwt_exp(&self.developer_token);
        self
    }
    
    pub fn decode_jwt_exp(token: &str) -> Option<String> {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        
        // JWT format: header.payload.signature
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        
        // Decode payload (base64url)
        let payload = parts[1];
        let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
        let json_str = String::from_utf8(decoded).ok()?;
        
        // Parse JSON to get exp claim
        let json: serde_json::Value = serde_json::from_str(&json_str).ok()?;
        let exp = json.get("exp")?.as_i64()?;
        
        // Convert Unix timestamp to ISO-8601
        let datetime = chrono::DateTime::from_timestamp(exp, 0)?;
        Some(datetime.to_rfc3339())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastfmSession {
    pub session_key: String,
    pub username: String,
    pub api_key: String,
    pub shared_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareAccount {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareOauth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64, // unix seconds
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub apple: Option<AppleTokens>,
    pub lastfm: Option<LastfmSession>,
    pub cloudflare_oauth: Option<CloudflareOauth>,
    pub cloudflare_token: Option<String>,
    pub cloudflare_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    pub poll_interval_minutes: u32, // 1, 2, 5, 10, 15, or 30
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            poll_interval_minutes: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployStatus {
    pub deployed: bool,
    pub worker_name: Option<String>,
    pub last_run_iso: Option<String>,
    pub total_scrobbled: u64,
    pub total_runs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentScrobble {
    pub artist: String,
    pub track: String,
    pub album: Option<String>,
    pub timestamp_iso: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerStats {
    pub total_scrobbled: u64,
    pub total_runs: u64,
    pub total_errors: u64,
    pub last_error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerLedger {
    pub version: u32,
    pub last_run_iso: Option<String>,
    pub recent_scrobbles: Vec<RecentScrobble>,
    pub stats: LedgerStats,
}


// Generic error string — we convert anyhow to String for serialization
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- Apple Music ----------

#[tauri::command]
pub async fn apple_start_auth(app: AppHandle) -> Result<AppleTokens, String> {
    auth::apple::start_auth_flow(&app).await.map_err(err)
}

#[tauri::command]
pub async fn apple_get_tokens() -> Result<Option<AppleTokens>, String> {
    storage::load_apple_tokens().map_err(err)
}

#[tauri::command]
pub async fn apple_cancel_auth(app: AppHandle) -> Result<(), String> {
    auth::apple::cancel_auth_flow(&app).await.map_err(err)
}

// ---------- Last.fm ----------

#[tauri::command]
pub async fn lastfm_start_auth(
    app: AppHandle,
    api_key: String,
    shared_secret: String,
) -> Result<LastfmSession, String> {
    auth::lastfm::start_auth_flow(&app, api_key, shared_secret)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn lastfm_cancel_auth() -> Result<(), String> {
    auth::lastfm::cancel_auth_flow().await.map_err(err)
}

// ---------- Cloudflare ----------

#[tauri::command]
pub async fn cloudflare_validate_token(token: String) -> Result<bool, String> {
    auth::cloudflare::validate_token(&token).await.map_err(err)
}

#[tauri::command]
pub async fn cloudflare_list_accounts(token: String) -> Result<Vec<CloudflareAccount>, String> {
    // Cloudflare accepts both OAuth access tokens and API tokens with the
    // same Authorization: Bearer <token> header shape.
    auth::cloudflare::list_accounts(&token).await.map_err(err)
}

#[tauri::command]
pub async fn cloudflare_oauth_login(app: AppHandle) -> Result<CloudflareOauth, String> {
    let oauth = auth::cloudflare_oauth::start_oauth_flow(&app)
        .await
        .map_err(err)?;

    storage::save_cloudflare_oauth(&oauth).map_err(err)?;
    let saved = storage::load_cloudflare_oauth().map_err(err)?;
    if saved.as_ref().map(|o| o.access_token.as_str()) != Some(oauth.access_token.as_str()) {
        return Err("Cloudflare OAuth credentials did not persist to keychain".to_string());
    }

    Ok(oauth)
}

/// Decode JWT expiry from an existing Apple developer token
#[tauri::command]
pub fn apple_decode_token_expiry(developer_token: String) -> Result<Option<String>, String> {
    Ok(AppleTokens::decode_jwt_exp(&developer_token))
}

#[tauri::command]
pub async fn cloudflare_oauth_logout() -> Result<(), String> {
    if let Some(oauth) = storage::load_cloudflare_oauth().map_err(err)? {
        // Best-effort revocation: ignore any failures and still clear local state.
        let _ = auth::cloudflare_oauth::revoke_token(&oauth.access_token).await;
        let _ = auth::cloudflare_oauth::revoke_token(&oauth.refresh_token).await;
    }
    storage::clear_cloudflare_oauth().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn cloudflare_save_credentials(
    token: String,
    account_id: String,
) -> Result<(), String> {
    // Validate first so we don't store a broken token
    auth::cloudflare::validate_token(&token).await.map_err(err)?;
    auth::cloudflare::preflight_deploy_access(&token, &account_id)
        .await
        .map_err(err)?;
    storage::save_cloudflare_token(&token).map_err(err)?;
    storage::save_cloudflare_account_id(&account_id).map_err(err)?;

    // Verify persistence immediately so keychain issues fail here (with a
    // useful error) instead of later on the deploy screen.
    let saved_token = storage::load_cloudflare_token().map_err(err)?;
    if saved_token.as_deref() != Some(token.as_str()) {
        return Err("Cloudflare token did not persist to keychain".to_string());
    }

    let saved_account_id = storage::load_cloudflare_account_id().map_err(err)?;
    if saved_account_id.as_deref() != Some(account_id.as_str()) {
        return Err("Cloudflare account id did not persist to keychain".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn cloudflare_save_account_id(account_id: String) -> Result<(), String> {
    storage::save_cloudflare_account_id(&account_id).map_err(err)
}

#[tauri::command]
pub fn cloudflare_template_url() -> String {
    auth::cloudflare::TOKEN_TEMPLATE_URL.to_string()
}

// ---------- Stored credentials ----------

#[tauri::command]
pub async fn storage_get_all() -> Result<StoredCredentials, String> {
    let apple = storage::load_apple_tokens().map_err(err)?;
    let lastfm = storage::load_lastfm_session().map_err(err)?;
    let cloudflare_oauth = storage::load_cloudflare_oauth().map_err(err)?;
    let cloudflare_token = storage::load_cloudflare_token().map_err(err)?;
    let cloudflare_account_id = storage::load_cloudflare_account_id().map_err(err)?;

    // Log what we loaded for debugging
    log::debug!(
        "Loaded credentials: apple={}, lastfm={}, oauth={}, token={}, account_id={}",
        apple.is_some(),
        lastfm.is_some(),
        cloudflare_oauth.is_some(),
        cloudflare_token.is_some(),
        cloudflare_account_id.is_some()
    );

    Ok(StoredCredentials {
        apple,
        lastfm,
        cloudflare_oauth,
        cloudflare_token,
        cloudflare_account_id,
    })
}

#[tauri::command]
pub async fn storage_clear_all() -> Result<(), String> {
    storage::clear_all().map_err(err)
}

// ---------- Deployment ----------

#[tauri::command]
pub async fn deploy_worker(
    app: AppHandle,
    account_id: String,
    poll_interval_minutes: u32,
    listenbrainz_token: Option<String>,
    webhook_url: Option<String>,
) -> Result<String, String> {
    crate::deploy::deploy_full(
        &app,
        &account_id,
        poll_interval_minutes,
        listenbrainz_token,
        webhook_url,
    )
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn save_user_settings(settings: UserSettings) -> Result<(), String> {
    storage::save_user_settings(&settings).map_err(err)
}

#[tauri::command]
pub async fn load_user_settings() -> Result<UserSettings, String> {
    storage::load_user_settings().map_err(err)
}

#[tauri::command]
pub async fn rotate_apple_tokens(
    app: AppHandle,
    account_id: String,
) -> Result<(), String> {
    let apple = auth::apple::start_auth_flow(&app).await.map_err(err)?;
    storage::save_apple_tokens(&apple).map_err(err)?;
    crate::deploy::rotate_apple_tokens(&account_id, &apple)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub async fn get_worker_url() -> Result<Option<String>, String> {
    storage::load_worker_url().map_err(err)
}

#[tauri::command]
pub async fn get_status_auth_key() -> Result<Option<String>, String> {
    storage::load_status_auth_key().map_err(err)
}

#[tauri::command]
pub async fn get_worker_status() -> Result<WorkerLedger, String> {
    let worker_url = storage::load_worker_url().map_err(err)?;
    let auth_key = storage::load_status_auth_key().map_err(err)?;

    if worker_url.is_none() || auth_key.is_none() {
        return Err("Worker not deployed or missing status auth key".to_string());
    }

    let ledger_url = format!("{}/status?key={}", worker_url.unwrap(), auth_key.unwrap());
    let resp = reqwest::Client::new()
        .get(&ledger_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch worker ledger: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Worker status HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }

    let ledger = resp.json::<WorkerLedger>().await
        .map_err(|e| format!("Failed to parse worker ledger JSON: {}", e))?;

    Ok(ledger)
}


#[tauri::command]
pub async fn deploy_status(app: AppHandle, account_id: String) -> Result<DeployStatus, String> {
    crate::deploy::fetch_status(&app, &account_id)
        .await
        .map_err(err)
}

/// Debug command: Export Apple tokens for API testing (careful - these are sensitive!)
#[tauri::command]
pub async fn debug_export_apple_tokens() -> Result<serde_json::Value, String> {
    let tokens = storage::load_apple_tokens().map_err(err)?;
    
    match tokens {
        Some(t) => {
            // Test the tokens immediately
            let client = reqwest::Client::new();
            let test_resp = client
                .get("https://api.music.apple.com/v1/me/recent/played/tracks?limit=1")
                .header("Authorization", format!("Bearer {}", t.developer_token))
                .header("Music-User-Token", &t.music_user_token)
                .header("Origin", "https://music.apple.com")
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await;
                
            let test_result = match test_resp {
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    serde_json::json!({
                        "status": status.as_u16(),
                        "ok": status.is_success(),
                        "body_preview": body.chars().take(200).collect::<String>()
                    })
                }
                Err(e) => serde_json::json!({"error": e.to_string()})
            };
            
            Ok(serde_json::json!({
                "tokens_present": true,
                "developer_token_preview": format!("{}...", &t.developer_token[..20.min(t.developer_token.len())]),
                "music_user_token_preview": format!("{}...", &t.music_user_token[..20.min(t.music_user_token.len())]),
                "api_test": test_result,
                "curl_command_recent": format!(
                    "curl -H \"Authorization: Bearer {}\" -H \"Music-User-Token: {}\" -H \"Origin: https://music.apple.com\" \"https://api.music.apple.com/v1/me/recent/played/tracks?limit=10\"",
                    t.developer_token, t.music_user_token
                ),
            }))
        }
        None => Ok(serde_json::json!({"tokens_present": false}))
    }
}
