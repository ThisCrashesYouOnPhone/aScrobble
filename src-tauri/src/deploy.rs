//! Cloudflare deployment orchestration.
//!
//! Given the user's API token, account id, and stored credentials, this
//! module:
//!   1. Reads the bundled worker.js from app resources
//!   2. Ensures a KV namespace named "amusic-state" exists
//!   3. Uploads the worker script with the KV binding
//!   4. Sets four worker secrets (Last.fm credentials + a random admin secret)
//!   5. Seeds Apple tokens directly into KV (so they can be rotated later
//!      without redeploying the worker)
//!   6. Configures a 5-minute cron trigger
//!
//! Each step emits a `deploy-progress` Tauri event so the React UI can show
//! real-time progress.
//!
//! All API calls are bearer-authenticated and use the standard
//! `{"success": bool, "errors": [...], "result": ...}` envelope format.

use anyhow::{anyhow, Result};
use base64::Engine;
use rand::RngCore;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::storage;

const CF_API: &str = "https://api.cloudflare.com/client/v4";
const WORKER_NAME: &str = "amusic-scrobbler";
const KV_NAMESPACE_TITLE: &str = "amusic-state";
const KV_BINDING_NAME: &str = "AMUSIC_STATE";
const COMPAT_DATE: &str = "2025-04-01";
const CRON_EXPRESSION: &str = "*/5 * * * *";
const TOTAL_STEPS: u32 = 7;

// KV key names — MUST match worker/src/kv_keys.ts
// Underscore-separated so they're safe in URL path segments.
const KV_KEY_APPLE_DEV_TOKEN: &str = "apple_dev_token";
const KV_KEY_APPLE_USER_TOKEN: &str = "apple_user_token";

// ---------- progress events ----------

#[derive(Debug, Clone, Serialize)]
pub struct DeployProgress {
    pub step: u32,
    pub total: u32,
    pub label: String,
}

fn emit(app: &AppHandle, step: u32, label: &str) {
    let payload = DeployProgress {
        step,
        total: TOTAL_STEPS,
        label: label.to_string(),
    };
    if let Err(e) = app.emit("deploy-progress", payload) {
        log::warn!("failed to emit deploy progress: {e}");
    }
    log::info!("deploy step {}/{}: {}", step, TOTAL_STEPS, label);
}

// ---------- public entry ----------

/// Run the full deploy sequence. Returns the worker name on success.
pub async fn deploy_full(app: &AppHandle, account_id: &str) -> Result<String> {
    emit(app, 1, "Reading worker script");
    let script = read_worker_script(app)?;

    emit(app, 2, "Loading credentials from keychain");
    let token = storage::load_cloudflare_token()?
        .ok_or_else(|| anyhow!("Cloudflare token missing from keychain"))?;
    let apple = storage::load_apple_tokens()?
        .ok_or_else(|| anyhow!("Apple tokens missing from keychain"))?;
    let lastfm = storage::load_lastfm_session()?
        .ok_or_else(|| anyhow!("Last.fm session missing from keychain"))?;

    let client = build_client();

    emit(app, 3, "Setting up KV namespace");
    let kv_id = ensure_kv_namespace(&client, &token, account_id).await?;

    emit(app, 4, "Uploading worker script");
    upload_worker_script(&client, &token, account_id, &script, &kv_id).await?;

    emit(app, 5, "Setting worker secrets");
    let status_auth_key = generate_status_auth_key();
    storage::save_status_auth_key(&status_auth_key)?;
    set_all_secrets(&client, &token, account_id, &lastfm, &status_auth_key).await?;

    emit(app, 6, "Seeding Apple tokens to KV");
    seed_apple_tokens(&client, &token, account_id, &kv_id, &apple).await?;

    emit(app, 7, "Configuring 5-minute cron trigger");
    set_cron_schedule(&client, &token, account_id).await?;

    Ok(WORKER_NAME.to_string())
}

// ---------- helpers ----------

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("amusic/0.2 deploy")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest client build")
}

fn read_worker_script(app: &AppHandle) -> Result<String> {
    use tauri::path::BaseDirectory;
    let path = app
        .path()
        .resolve("resources/worker.js", BaseDirectory::Resource)
        .map_err(|e| anyhow!("Failed to resolve worker.js resource path: {}", e))?;
    std::fs::read_to_string(&path)
        .map_err(|e| anyhow!("Failed to read worker.js at {:?}: {}", path, e))
}

fn generate_status_auth_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ---------- envelope ----------

#[derive(Debug, Deserialize)]
struct CfEnvelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<CfError>,
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
struct CfError {
    code: i64,
    message: String,
}

fn check_with_result<T>(envelope: CfEnvelope<T>, ctx: &str) -> Result<T> {
    if !envelope.success {
        let msg = envelope
            .errors
            .iter()
            .map(|e| format!("[{}] {}", e.code, e.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(anyhow!("{}: {}", ctx, msg));
    }
    envelope
        .result
        .ok_or_else(|| anyhow!("{}: success=true but no result field", ctx))
}

fn check_success<T>(envelope: CfEnvelope<T>, ctx: &str) -> Result<()> {
    if envelope.success {
        return Ok(());
    }
    let msg = envelope
        .errors
        .iter()
        .map(|e| format!("[{}] {}", e.code, e.message))
        .collect::<Vec<_>>()
        .join("; ");
    if msg.is_empty() {
        return Err(anyhow!("{}: request failed with no error details", ctx));
    }
    Err(anyhow!("{}: {}", ctx, msg))
}

// ---------- KV namespace ----------

#[derive(Debug, Deserialize)]
struct KvNamespace {
    id: String,
    title: String,
}

/// Find an existing namespace by title, or create one if it doesn't exist.
async fn ensure_kv_namespace(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<String> {
    // Try to find an existing namespace with our title
    let list_url = format!("{}/accounts/{}/storage/kv/namespaces", CF_API, account_id);
    let resp = client
        .get(&list_url)
        .bearer_auth(token)
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|e| anyhow!("Failed to list KV namespaces: {}", e))?;

    let envelope: CfEnvelope<Vec<KvNamespace>> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse KV namespace list response: {}", e))?;
    let existing = check_with_result(envelope, "list KV namespaces")?;

    if let Some(ns) = existing.iter().find(|n| n.title == KV_NAMESPACE_TITLE) {
        log::info!("reusing existing KV namespace {}", ns.id);
        return Ok(ns.id.clone());
    }

    // Create a new one
    let create_url = format!("{}/accounts/{}/storage/kv/namespaces", CF_API, account_id);
    let resp = client
        .post(&create_url)
        .bearer_auth(token)
        .json(&json!({ "title": KV_NAMESPACE_TITLE }))
        .send()
        .await
        .map_err(|e| anyhow!("Failed to create KV namespace: {}", e))?;

    let envelope: CfEnvelope<KvNamespace> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse KV namespace create response: {}", e))?;
    let created = check_with_result(envelope, "create KV namespace")?;
    log::info!("created new KV namespace {}", created.id);
    Ok(created.id)
}

// ---------- Worker script upload ----------

/// Upload the worker.js script with a KV binding pointing at our namespace.
/// Uses multipart/form-data per the Cloudflare Workers script upload API.
async fn upload_worker_script(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    script: &str,
    kv_namespace_id: &str,
) -> Result<()> {
    let metadata = json!({
        "main_module": "worker.js",
        "compatibility_date": COMPAT_DATE,
        // Note: no "nodejs_compat" flag — the bundled worker uses pure-TS
        // MD5 and doesn't depend on any Node built-ins.
        "bindings": [
            {
                "type": "kv_namespace",
                "name": KV_BINDING_NAME,
                "namespace_id": kv_namespace_id
            }
        ]
    });

    let form = Form::new()
        .part(
            "metadata",
            Part::text(metadata.to_string())
                .mime_str("application/json")
                .map_err(|e| anyhow!("metadata mime: {}", e))?,
        )
        .part(
            "worker.js",
            Part::text(script.to_string())
                .file_name("worker.js")
                .mime_str("application/javascript+module")
                .map_err(|e| anyhow!("script mime: {}", e))?,
        );

    let url = format!(
        "{}/accounts/{}/workers/scripts/{}",
        CF_API, account_id, WORKER_NAME
    );
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to upload worker script: {}", e))?;

    let envelope: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse worker upload response: {}", e))?;
    check_success(envelope, "upload worker script")?;
    Ok(())
}

// ---------- Worker secrets ----------

async fn set_secret(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    name: &str,
    value: &str,
) -> Result<()> {
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}/secrets",
        CF_API, account_id, WORKER_NAME
    );
    let body = json!({
        "name": name,
        "text": value,
        "type": "secret_text"
    });
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to set secret {}: {}", name, e))?;

    let envelope: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse secret set response for {}: {}", name, e))?;
    check_success(envelope, &format!("set secret {}", name))?;
    Ok(())
}

async fn set_all_secrets(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    lastfm: &crate::commands::LastfmSession,
    status_auth_key: &str,
) -> Result<()> {
    set_secret(client, token, account_id, "LASTFM_API_KEY", &lastfm.api_key).await?;
    set_secret(
        client,
        token,
        account_id,
        "LASTFM_SHARED_SECRET",
        &lastfm.shared_secret,
    )
    .await?;
    set_secret(
        client,
        token,
        account_id,
        "LASTFM_SESSION_KEY",
        &lastfm.session_key,
    )
    .await?;
    // Required by the TS worker to auth the /status and /trigger endpoints.
    // Without this secret the worker returns 401 on all non-health requests.
    set_secret(client, token, account_id, "STATUS_AUTH_KEY", status_auth_key).await?;
    Ok(())
}

// ---------- KV value seeding ----------

async fn put_kv_value(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    namespace_id: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    let url = format!(
        "{}/accounts/{}/storage/kv/namespaces/{}/values/{}",
        CF_API, account_id, namespace_id, key
    );
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .header("Content-Type", "text/plain")
        .body(value.to_string())
        .send()
        .await
        .map_err(|e| anyhow!("Failed to put KV {}: {}", key, e))?;

    let envelope: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse KV put response for {}: {}", key, e))?;
    check_success(envelope, &format!("put KV {}", key))?;
    Ok(())
}

async fn seed_apple_tokens(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    namespace_id: &str,
    apple: &crate::commands::AppleTokens,
) -> Result<()> {
    // These key names MUST match worker/src/kv_keys.ts exactly.
    put_kv_value(
        client,
        token,
        account_id,
        namespace_id,
        KV_KEY_APPLE_DEV_TOKEN,
        &apple.developer_token,
    )
    .await?;
    put_kv_value(
        client,
        token,
        account_id,
        namespace_id,
        KV_KEY_APPLE_USER_TOKEN,
        &apple.music_user_token,
    )
    .await?;
    Ok(())
}

// ---------- Cron trigger ----------

async fn set_cron_schedule(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<()> {
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}/schedules",
        CF_API, account_id, WORKER_NAME
    );
    let body = json!([{ "cron": CRON_EXPRESSION }]);
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to set cron schedule: {}", e))?;

    let envelope: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse cron schedule response: {}", e))?;
    check_success(envelope, "set cron schedule")?;
    Ok(())
}

// ---------- Status query ----------

/// Query the deployed worker for its current status. For v2.0 we just check
/// that the worker script is registered. Future versions can hit a public
/// /status endpoint via workers.dev for live ledger stats.
pub async fn fetch_status(
    app: &AppHandle,
    account_id: &str,
) -> Result<crate::commands::DeployStatus> {
    let _ = app; // unused for now
    let token = storage::load_cloudflare_token()?
        .ok_or_else(|| anyhow!("Cloudflare token missing"))?;

    let client = build_client();
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}",
        CF_API, account_id, WORKER_NAME
    );
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to query worker: {}", e))?;

    let deployed = resp.status().is_success();
    Ok(crate::commands::DeployStatus {
        deployed,
        worker_name: if deployed {
            Some(WORKER_NAME.to_string())
        } else {
            None
        },
        last_run_iso: None,
        total_scrobbled: 0,
        total_runs: 0,
    })
}
