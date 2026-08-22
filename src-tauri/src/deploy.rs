//! Cloudflare deployment orchestration.
//!
//! Given the user's API token, account id, and stored credentials, this
//! module:
//!   1. Reads the bundled worker.js from app resources
//!   2. Ensures a KV namespace named "ascrobble-state" exists
//!   3. Uploads the worker script with the KV binding
//!   4. Sets four worker secrets (Last.fm credentials + a random admin secret)
//!   5. Seeds Apple tokens directly into KV (so they can be rotated later
//!      without redeploying the worker)
//!   6. Configures a 5-minute cron trigger
//!   7. Warms up the worker route so it's immediately accessible
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

use crate::{auth, storage};

const CF_API: &str = "https://api.cloudflare.com/client/v4";
const WORKER_NAME: &str = "ascrobble-scrobbler";
const KV_NAMESPACE_TITLE: &str = "ascrobble-state";
const KV_BINDING_NAME: &str = "ASCROBBLE_STATE";
const COMPAT_DATE: &str = "2025-04-01";
const VALID_INTERVALS: &[u32] = &[1, 2, 3, 5, 10, 15, 30];
const TOTAL_STEPS: u32 = 9;

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
pub async fn deploy_full(
    app: &AppHandle,
    account_id: &str,
    poll_interval_minutes: u32,
    listenbrainz_token: Option<String>,
    webhook_url: Option<String>,
) -> Result<String> {
    if !VALID_INTERVALS.contains(&poll_interval_minutes) {
        return Err(anyhow!(
            "Invalid polling interval: {} minutes. Must be one of: {:?}",
            poll_interval_minutes,
            VALID_INTERVALS
        ));
    }
    emit(app, 1, "Reading worker script");
    let script = read_worker_script(app)?;

    emit(app, 2, "Loading credentials from keychain");
    let token = resolve_cloudflare_api_token().await?;
    let apple = storage::load_apple_tokens()?
        .ok_or_else(|| anyhow!("Apple tokens missing from keychain"))?;
    let lastfm = storage::load_lastfm_session()?
        .ok_or_else(|| anyhow!("Last.fm session missing from keychain"))?;

    let client = build_client();

    // Detect and clean up any duplicate/stale worker scripts before deploying.
    // This handles cases where a user previously deployed with a different name
    // or has multiple ascrobble workers cluttering their account.
    emit(app, 3, "Checking for existing worker(s)");
    match list_and_cleanup_workers(&client, &token, account_id).await {
        Ok(cleaned) if cleaned > 0 => {
            log::info!("Removed {} stale duplicate worker(s) before fresh deploy", cleaned);
        }
        Ok(_) => {}
        Err(e) => {
            // Non-fatal — log and continue
            log::warn!("Could not check for duplicate workers: {}", e);
        }
    }

    let kv_id = ensure_kv_namespace(&client, &token, account_id).await?;

    emit(app, 4, "Uploading worker script");
    upload_worker_script(&client, &token, account_id, &script, &kv_id).await?;
    // The raw Cloudflare API does NOT automatically enable the workers.dev
    // subdomain route when a script is uploaded — Wrangler does this explicitly.
    // Without this call, fresh deploys result in 404 on the workers.dev URL.
    enable_workers_dev_route(&client, &token, account_id).await?;

    emit(app, 5, "Setting worker secrets");
    let status_auth_key = generate_status_auth_key();
    storage::save_status_auth_key(&status_auth_key)?;
    set_all_secrets(
        &client,
        &token,
        account_id,
        &lastfm,
        &status_auth_key,
        listenbrainz_token.as_deref(),
        webhook_url.as_deref(),
    )
    .await?;

    emit(app, 6, "Seeding Apple tokens to KV");
    seed_apple_tokens(&client, &token, account_id, &kv_id, &apple).await?;

    let cron_label = format!("Configuring {}-minute cron trigger", poll_interval_minutes);
    emit(app, 7, &cron_label);
    let cron_expression = format!("*/{} * * * *", poll_interval_minutes);
    set_cron_schedule(&client, &token, account_id, &cron_expression).await?;

    // Warm up the worker route so it's immediately accessible
    emit(app, 8, "Warming up worker route");
    let _ = warmup_worker(&client, &token, account_id).await;

    // Resolve and store the worker's workers.dev URL for the dashboard
    let worker_url = match resolve_worker_url(&client, &token, account_id).await {
        Ok(Some(url)) => {
            if let Err(e) = storage::save_worker_url(&url) {
                log::warn!("Failed to save worker URL to storage: {}", e);
            } else {
                log::info!("Successfully saved worker URL: {}", url);
            }
            Some(url)
        }
        Ok(None) => {
            log::warn!(
                "Worker deployed successfully, but no workers.dev subdomain found. \
                 Visit https://dash.cloudflare.com/{}/workers to set up a subdomain for dashboard access.",
                account_id
            );
            None
        }
        Err(e) => {
            log::warn!("Failed to resolve worker URL: {}", e);
            None
        }
    };

    // Wait for the STATUS_AUTH_KEY secret to propagate to all Cloudflare edge
    // nodes before returning. Without this, the dashboard's first /status call
    // arrives before the secret is visible to the worker and gets a spurious 401.
    emit(app, 9, "Waiting for worker to be ready");
    if let Some(url) = &worker_url {
        await_secret_propagation(url, &status_auth_key).await?;
    }

    Ok(WORKER_NAME.to_string())
}

// ---------- helpers ----------

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("aScrobble/0.2 deploy")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest client build")
}

pub(crate) async fn resolve_cloudflare_api_token() -> Result<String> {
    let now = chrono::Utc::now().timestamp();
    if let Some(stored_oauth) = storage::load_cloudflare_oauth()? {
        if now < stored_oauth.expires_at - 60 {
            return Ok(stored_oauth.access_token);
        }

        match auth::cloudflare_oauth::refresh_access_token(&stored_oauth.refresh_token).await {
            Ok(refreshed) => {
                storage::save_cloudflare_oauth(&refreshed)?;
                return Ok(refreshed.access_token);
            }
            Err(e) => {
                log::warn!("Cloudflare OAuth token refresh failed, clearing stale OAuth session: {}", e);
                let _ = storage::clear_cloudflare_oauth();
                if let Ok(Some(api_token)) = storage::load_cloudflare_token() {
                    return Ok(api_token);
                }
                return Err(anyhow!(
                    "Cloudflare OAuth session expired or revoked (invalid_grant). Please click 'Login with Cloudflare' to sign in again."
                ));
            }
        }
    }

    if let Some(api_token) = storage::load_cloudflare_token()? {
        return Ok(api_token);
    }

    Err(anyhow!(
        "No Cloudflare credentials found. Authenticate with Cloudflare first."
    ))
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

    if let Some(ns) = existing.iter().find(|n| {
        let title_lower = n.title.to_lowercase();
        title_lower == "ascrobble-state" || title_lower == "ascrobble_state"
    }) {
        log::info!("reusing existing KV namespace '{}' ({})", ns.title, ns.id);
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

/// Check if a worker script already exists.
#[allow(dead_code)]
async fn check_worker_exists(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<bool> {
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}",
        CF_API, account_id, WORKER_NAME
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to check if worker exists: {}", e))?;

    Ok(resp.status().is_success())
}

/// List all workers on the account, find any named `ascrobble-*` other than the
/// canonical `WORKER_NAME`, and delete them. Returns the number of workers deleted.
async fn list_and_cleanup_workers(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<u32> {
    #[derive(Deserialize)]
    struct WorkerScript {
        id: String,
    }
    #[derive(Deserialize)]
    struct ScriptList {
        result: Option<Vec<WorkerScript>>,
    }

    let list_url = format!("{}/accounts/{}/workers/scripts", CF_API, account_id);
    let resp = client
        .get(&list_url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to list workers: {}", e))?;

    if !resp.status().is_success() {
        return Ok(0); // non-fatal
    }

    let body: ScriptList = resp.json().await.unwrap_or(ScriptList { result: None });
    let scripts = body.result.unwrap_or_default();

    let mut deleted = 0u32;
    for script in &scripts {
        let name_lower = script.id.to_lowercase();
        // Delete any worker that looks like an old ascrobble deployment
        // but is NOT the current canonical name.
        if name_lower.contains("ascrobble") && script.id != WORKER_NAME {
            log::info!("Deleting stale worker '{}' (duplicate of '{}')", script.id, WORKER_NAME);
            let del_url = format!(
                "{}/accounts/{}/workers/scripts/{}",
                CF_API, account_id, script.id
            );
            let del_resp = client
                .delete(&del_url)
                .bearer_auth(token)
                .send()
                .await;
            match del_resp {
                Ok(r) if r.status().is_success() => {
                    log::info!("Deleted stale worker '{}'", script.id);
                    deleted += 1;
                }
                Ok(r) => {
                    log::warn!("Could not delete '{}': HTTP {}", script.id, r.status());
                }
                Err(e) => {
                    log::warn!("Could not delete '{}': {}", script.id, e);
                }
            }
        }
    }
    Ok(deleted)
}

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
        ],
        "observability": {
            "enabled": true,
            "head_sampling_rate": 1.0,
            "logs": {
                "enabled": true,
                "head_sampling_rate": 1.0
            },
            "traces": {
                "enabled": true,
                "head_sampling_rate": 1.0
            }
        }
    });
    log::info!(
        "Uploading worker with KV binding name: '{}' (namespace_id: {})",
        KV_BINDING_NAME, kv_namespace_id
    );
    log::debug!("Full metadata: {}", serde_json::to_string_pretty(&metadata).unwrap_or_default());
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
    log::debug!("Setting secret: {}", name);
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to set secret {}: {}", name, e))?;

    let status = resp.status();
    let envelope: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse secret set response for {}: {}", name, e))?;
    
    if !envelope.success {
        let errors = envelope.errors.iter()
            .map(|e| format!("{}: {}", e.code, e.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(anyhow!("Failed to set secret {} (HTTP {}): {}", name, status, errors));
    }
    
    log::info!("Successfully set secret: {}", name);
    Ok(())
}

async fn set_all_secrets(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    lastfm: &crate::commands::LastfmSession,
    status_auth_key: &str,
    listenbrainz_token: Option<&str>,
    webhook_url: Option<&str>,
) -> Result<()> {
    log::info!("Setting all worker secrets");
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

    if let Some(lb_token) = listenbrainz_token {
        log::info!("Setting optional LISTENBRAINZ_TOKEN secret");
        set_secret(client, token, account_id, "LISTENBRAINZ_TOKEN", lb_token).await?;
    }
    if let Some(hook) = webhook_url {
        log::info!("Setting optional NOTIFY_WEBHOOK_URL secret");
        set_secret(client, token, account_id, "NOTIFY_WEBHOOK_URL", hook).await?;
    }

    log::info!("All worker secrets have been set successfully");
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

pub(crate) async fn set_cron_schedule(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
    cron_expression: &str,
) -> Result<()> {
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}/schedules",
        CF_API, account_id, WORKER_NAME
    );
    let body = json!([{ "cron": cron_expression }]);
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

// ---------- workers.dev route ----------

/// Enable the workers.dev subdomain route for the script.
///
/// Wrangler calls `POST /accounts/{id}/workers/scripts/{name}/subdomain`
/// with `{"enabled": true}` after every upload. The raw Cloudflare REST API
/// does NOT do this automatically. Without this step, fresh deploys result in
/// a 404 on the workers.dev URL even though the script exists internally.
///
/// On re-deploys the route persists from the previous deploy, which is why
/// this issue only surfaces on the very first deploy (empty account).
async fn enable_workers_dev_route(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<()> {
    let url = format!(
        "{}/accounts/{}/workers/scripts/{}/subdomain",
        CF_API, account_id, WORKER_NAME
    );
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&json!({ "enabled": true }))
        .send()
        .await
        .map_err(|e| anyhow!("Failed to enable workers.dev route: {}", e))?;

    // 409 Conflict means "already enabled" — that's fine.
    let status = resp.status();
    if status.as_u16() == 409 {
        log::info!("workers.dev route already enabled (409 Conflict — that's ok)");
        return Ok(());
    }

    // Cloudflare returns an empty body (HTTP 200) on success; try to parse
    // as JSON envelope only when the body is non-empty.
    let body = resp
        .text()
        .await
        .unwrap_or_default();

    if !status.is_success() {
        // Authorization errors (401 Unauthorized, 403 Forbidden) indicate
        // credentials or permissions issues that must be fixed by the user.
        // Abort the deployment immediately so they see the error clearly.
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(anyhow!(
                "Cloudflare API permission error (HTTP {}): {}. \
                 Check that your API token has 'Workers:Edit' permission.",
                status,
                body.chars().take(300).collect::<String>()
            ));
        }

        // Other errors (5xx, 4xx besides 401/403) are non-fatal:
        // the worker is deployed; only the HTTP URL (workers.dev) won't be reachable.
        log::warn!(
            "workers.dev route enable returned HTTP {}: {} — continuing with warning",
            status,
            body.chars().take(300).collect::<String>()
        );
        return Ok(());
    }

    log::info!("workers.dev route enabled for {}", WORKER_NAME);
    Ok(())
}

// ---------- Worker warmup ----------

/// Warm up the worker route by making an HTTP request to the /health endpoint.
/// This initializes the Cloudflare route so the worker is immediately accessible.
/// This is a best-effort operation - we don't fail the deployment if it fails.
async fn warmup_worker(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<()> {
    // Try to get the subdomain so we can construct the worker URL
    let url = format!("{}/accounts/{}/workers/subdomain", CF_API, account_id);
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to get subdomain for warmup: {}", e))?;

    if !resp.status().is_success() {
        log::warn!("Subdomain query failed (no workers.dev subdomain set up yet)");
        return Err(anyhow!(
            "No workers.dev subdomain configured - worker is deployed but not yet accessible via workers.dev"
        ));
    }

    let envelope: CfEnvelope<SubdomainResult> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse subdomain response during warmup: {}", e))?;

    let subdomain = match envelope.result {
        Some(r) if !r.subdomain.is_empty() => r.subdomain,
        _ => {
            return Err(anyhow!("No subdomain in response"));
        }
    };

    let worker_url = format!("https://{}.{}.workers.dev", WORKER_NAME, subdomain);
    log::info!("Warming up worker at {}", worker_url);

    // Make up to 3 attempts with 500ms delays to warm up the route
    for attempt in 1..=3 {
        match client
            .get(format!("{}/health", worker_url))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                log::info!("Worker warmup successful on attempt {}", attempt);
                return Ok(());
            }
            Ok(resp) => {
                log::debug!("Worker warmup attempt {} got HTTP {}", attempt, resp.status());
            }
            Err(e) => {
                log::debug!("Worker warmup attempt {} failed: {}", attempt, e);
            }
        }

        if attempt < 3 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    // After 3 attempts, log but don't fail - the worker is deployed,
    // it just might take a moment longer to be fully routable.
    log::warn!("Worker warmup did not complete, but worker is deployed and should be accessible shortly");
    Ok(())
}

/// Poll /status with the real auth key until the worker acknowledges it,
/// confirming that Cloudflare has propagated the STATUS_AUTH_KEY secret to
/// all edge nodes. Without this, the dashboard's first request gets a 401.
///
/// Returns Err immediately on 404 — that means the worker upload failed or
/// the worker was deleted, not a propagation delay. Returns Ok on timeout
/// so a slow network doesn't block an otherwise successful deploy.
async fn await_secret_propagation(worker_url: &str, auth_key: &str) -> Result<()> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Could not build client for secret propagation check: {}", e);
            return Ok(());
        }
    };

    let status_url = format!("{}/status?key={}", worker_url, auth_key);

    // On a fresh deploy the workers.dev route itself needs a few seconds to
    // become routable after enable_workers_dev_route() is called, so the first
    // several polls legitimately return 404. We allow up to 10 consecutive 404s
    // (~20 s) before treating it as a fatal "worker truly doesn't exist" error.
    let mut consecutive_404s: u32 = 0;

    for attempt in 1..=20 {
        match client.get(&status_url).send().await {
            Ok(resp) if resp.status().as_u16() == 200 => {
                log::info!(
                    "Worker ready: STATUS_AUTH_KEY propagated after {} attempt(s)",
                    attempt
                );
                return Ok(());
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                consecutive_404s += 1;
                log::debug!(
                    "Propagation check {}/20: route not yet routable (404 #{}) — waiting 2s",
                    attempt,
                    consecutive_404s
                );
                // After 10 consecutive 404s (~20 s) the route should definitely
                // be active. If it's still 404 at that point, the upload failed.
                if consecutive_404s >= 10 {
                    return Err(anyhow!(
                        "Worker returned 404 after deploy — the script upload may have failed. \
                         Please try redeploying. If this keeps happening, check that your \
                         Cloudflare API token has Workers:Edit permission."
                    ));
                }
            }
            Ok(resp) => {
                // Any non-404 response (401, 403, 5xx…) means the route IS
                // active; reset the 404 streak and keep waiting for the secret.
                consecutive_404s = 0;
                log::debug!(
                    "Propagation check {}/20: HTTP {} — waiting 2s",
                    attempt,
                    resp.status()
                );
            }
            Err(e) => {
                log::debug!("Propagation check {}/20 failed: {} — waiting 2s", attempt, e);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    log::warn!(
        "Secret propagation timed out after 40s. \
         The worker is deployed; the dashboard may show a brief error on first load."
    );
    Ok(())
}

// ---------- Worker URL resolution ----------

#[derive(Debug, Deserialize)]
struct SubdomainResult {
    subdomain: String,
}

/// Try to resolve the worker's public workers.dev URL.
/// Returns None if the user hasn't set up a workers.dev subdomain.
async fn resolve_worker_url(
    client: &reqwest::Client,
    token: &str,
    account_id: &str,
) -> Result<Option<String>> {
    let url = format!("{}/accounts/{}/workers/subdomain", CF_API, account_id);
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to query workers.dev subdomain: {}", e))?;

    if !resp.status().is_success() {
        log::warn!(
            "Subdomain query returned HTTP {} - may indicate missing permissions or setup",
            resp.status()
        );
        return Ok(None);
    }

    let envelope: CfEnvelope<SubdomainResult> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse subdomain response: {}", e))?;

    match envelope.result {
        Some(r) if !r.subdomain.is_empty() => {
            let worker_url = format!("https://{}.{}.workers.dev", WORKER_NAME, r.subdomain);
            log::info!("Resolved worker URL: {}", worker_url);
            Ok(Some(worker_url))
        }
        Some(r) => {
            log::warn!("Subdomain response empty: {:?}", r);
            Ok(None)
        }
        None => {
            log::warn!("No subdomain in API response - user may not have subdomain set up");
            Ok(None)
        }
    }
}

// ---------- Apple token rotation ----------

/// Rotate Apple tokens in KV without a full redeploy.
pub async fn rotate_apple_tokens(
    account_id: &str,
    apple: &crate::commands::AppleTokens,
) -> Result<()> {
    let token = resolve_cloudflare_api_token().await?;
    let client = build_client();

    // Find the KV namespace ID
    let kv_id = ensure_kv_namespace(&client, &token, account_id).await?;

    // Write new Apple tokens to KV
    seed_apple_tokens(&client, &token, account_id, &kv_id, apple).await?;

    Ok(())
}

/// Re-upload the bundled worker script to Cloudflare without wiping secrets.
pub async fn redeploy_worker_script(app: &AppHandle) -> Result<()> {
    let token = resolve_cloudflare_api_token().await?;
    let account_id = storage::load_cloudflare_account_id()?
        .ok_or_else(|| anyhow!("Cloudflare account ID missing"))?;
    let script = read_worker_script(app)?;

    let client = build_client();
    let kv_id = ensure_kv_namespace(&client, &token, &account_id).await?;
    upload_worker_script(&client, &token, &account_id, &script, &kv_id).await?;
    enable_workers_dev_route(&client, &token, &account_id).await?;

    let poll_interval = storage::load_user_settings()
        .map(|s| s.poll_interval_minutes)
        .unwrap_or(1);
    let cron_expr = format!("*/{} * * * *", poll_interval);
    let _ = set_cron_schedule(&client, &token, &account_id, &cron_expr).await;

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
    let token = resolve_cloudflare_api_token().await?;

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
