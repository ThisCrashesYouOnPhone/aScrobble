//! Cloudflare authentication.
//!
//! Unlike Apple and Last.fm, we don't run an auth flow for Cloudflare — we
//! just ask the user to paste an API token they created in their dashboard.
//!
//! The desktop app deep-links them to the pre-filled token template:
//!   https://dash.cloudflare.com/profile/api-tokens?template=edit-cloudflare-workers
//! which creates a token with the right permissions for Workers + KV.
//!
//! We then:
//!   1. Validate the token via GET /user/tokens/verify
//!   2. List the user's accounts via GET /accounts
//!   3. Have the user pick one (most users have exactly one)
//!
//! The token is stored in the OS keychain.

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::commands::CloudflareAccount;

const CF_API: &str = "https://api.cloudflare.com/client/v4";

/// The deep-link URL the desktop app should open in the user's browser
/// to pre-fill the "Edit Cloudflare Workers" token template.
pub const TOKEN_TEMPLATE_URL: &str =
    "https://dash.cloudflare.com/profile/api-tokens?template=edit-cloudflare-workers";

#[derive(Debug, Deserialize)]
struct CfEnvelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<CfError>,
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
struct CfError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct VerifyResult {
    status: String,
}

#[derive(Debug, Deserialize)]
struct Account {
    id: String,
    name: String,
}

fn format_cf_errors(errors: &[CfError]) -> String {
    errors
        .iter()
        .map(|e| format!("[{}] {}", e.code, e.message))
        .collect::<Vec<_>>()
        .join("; ")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("aScrobble/0.2")
        .build()
        .expect("reqwest client")
}

/// Call /user/tokens/verify. Returns true if the token is active.
pub async fn validate_token(token: &str) -> Result<bool> {
    let resp = client()
        .get(format!("{}/user/tokens/verify", CF_API))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Cloudflare request failed: {}", e))?;

    let status = resp.status();
    let body: CfEnvelope<VerifyResult> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Cloudflare response: {}", e))?;

    if !body.success {
        let msg = body
            .errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        if !msg.is_empty() {
            return Err(anyhow!("Cloudflare rejected token: {}", msg));
        }
        return Err(anyhow!(
            "Cloudflare rejected token (HTTP {}): no error details",
            status
        ));
    }

    match body.result {
        Some(r) if r.status == "active" => Ok(true),
        Some(r) => Err(anyhow!("Token status is '{}', expected 'active'", r.status)),
        None => Err(anyhow!("Cloudflare response missing result")),
    }
}

/// List all accounts the token has access to. Most users have exactly one.
pub async fn list_accounts(token: &str) -> Result<Vec<CloudflareAccount>> {
    let resp = client()
        .get(format!("{}/accounts", CF_API))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| anyhow!("Cloudflare request failed: {}", e))?;

    let body: CfEnvelope<Vec<Account>> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Cloudflare response: {}", e))?;

    if !body.success {
        let msg = body
            .errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(anyhow!("Cloudflare /accounts failed: {}", msg));
    }

    Ok(body
        .result
        .unwrap_or_default()
        .into_iter()
        .map(|a| CloudflareAccount {
            id: a.id,
            name: a.name,
        })
        .collect())
}

/// Preflight deploy permissions for a selected account. This catches common
/// token-scope issues early (before the deploy step).
pub async fn preflight_deploy_access(token: &str, account_id: &str) -> Result<()> {
    let accounts = list_accounts(token).await?;
    if !accounts.iter().any(|a| a.id == account_id) {
        return Err(anyhow!(
            "Selected account is not accessible by this token. Re-select the account or regenerate the token."
        ));
    }

    // Harmless read on the KV API used by deploy step 3.
    let resp = client()
        .get(format!(
            "{}/accounts/{}/storage/kv/namespaces",
            CF_API, account_id
        ))
        .bearer_auth(token)
        .query(&[("per_page", "1")])
        .send()
        .await
        .map_err(|e| anyhow!("Cloudflare preflight request failed: {}", e))?;

    let status = resp.status();
    let body: CfEnvelope<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse Cloudflare preflight response: {}", e))?;

    if !body.success {
        let details = format_cf_errors(&body.errors);
        if body.errors.iter().any(|e| e.code == 10000) {
            return Err(anyhow!(
                "Token is valid but not authorized for KV on this account. \
Required permissions: Account -> Workers KV Storage:Edit and Account -> Workers Scripts:Edit. \
Cloudflare said: {}",
                details
            ));
        }
        return Err(anyhow!(
            "Cloudflare deploy preflight failed (HTTP {}): {}",
            status,
            details
        ));
    }

    Ok(())
}
