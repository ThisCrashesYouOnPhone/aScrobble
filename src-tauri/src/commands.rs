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
pub struct StoredCredentials {
    pub apple: Option<AppleTokens>,
    pub lastfm: Option<LastfmSession>,
    pub cloudflare_token: Option<String>,
    pub cloudflare_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployStatus {
    pub deployed: bool,
    pub worker_name: Option<String>,
    pub last_run_iso: Option<String>,
    pub total_scrobbled: u64,
    pub total_runs: u64,
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
    auth::cloudflare::list_accounts(&token).await.map_err(err)
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
pub fn cloudflare_template_url() -> String {
    auth::cloudflare::TOKEN_TEMPLATE_URL.to_string()
}

// ---------- Stored credentials ----------

#[tauri::command]
pub async fn storage_get_all() -> Result<StoredCredentials, String> {
    Ok(StoredCredentials {
        apple: storage::load_apple_tokens().map_err(err)?,
        lastfm: storage::load_lastfm_session().map_err(err)?,
        cloudflare_token: storage::load_cloudflare_token().map_err(err)?,
        cloudflare_account_id: storage::load_cloudflare_account_id().map_err(err)?,
    })
}

#[tauri::command]
pub async fn storage_clear_all() -> Result<(), String> {
    storage::clear_all().map_err(err)
}

// ---------- Deployment ----------

#[tauri::command]
pub async fn deploy_worker(app: AppHandle, account_id: String) -> Result<String, String> {
    crate::deploy::deploy_full(&app, &account_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn deploy_status(app: AppHandle, account_id: String) -> Result<DeployStatus, String> {
    crate::deploy::fetch_status(&app, &account_id)
        .await
        .map_err(err)
}
