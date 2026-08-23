//! Proactive health check and notification service.
//!
//! Periodically evaluates Apple Music JWT expiration, Last.fm status, and
//! Cloudflare worker responsiveness. Emits live `health-status` events to
//! the frontend and triggers desktop OS notifications when issues occur.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub apple_ok: bool,
    pub apple_days_remaining: Option<i64>,
    pub apple_expiry_iso: Option<String>,
    pub apple_expires_soon: bool, // <= 3 days
    pub apple_expired: bool,       // <= 0 days
    pub lastfm_ok: bool,
    pub worker_deployed: bool,
    pub worker_reachable: bool,
    pub worker_error: Option<String>,
    pub circuit_open: bool,
}

pub async fn check_health() -> HealthStatus {
    let mut status = HealthStatus {
        apple_ok: false,
        apple_days_remaining: None,
        apple_expiry_iso: None,
        apple_expires_soon: false,
        apple_expired: false,
        lastfm_ok: false,
        worker_deployed: false,
        worker_reachable: false,
        worker_error: None,
        circuit_open: false,
    };

    // 1. Apple Music token check
    if let Ok(Some(apple)) = storage::load_apple_tokens() {
        status.apple_ok = true;
        let exp_iso = apple.expires_at.or_else(|| {
            crate::commands::AppleTokens::decode_jwt_exp(&apple.developer_token)
        });
        if let Some(ref iso) = exp_iso {
            status.apple_expiry_iso = Some(iso.clone());
            if let Ok(dt) = DateTime::parse_from_rfc3339(iso) {
                let now = Utc::now();
                let diff_sec = dt.with_timezone(&Utc).timestamp() - now.timestamp();
                let days = diff_sec / 86400;
                status.apple_days_remaining = Some(days);
                if days <= 0 {
                    status.apple_expired = true;
                } else if days <= 3 {
                    status.apple_expires_soon = true;
                }
            }
        }
    }

    // 2. Last.fm session check
    if let Ok(Some(_)) = storage::load_lastfm_session() {
        status.lastfm_ok = true;
    }

    // 3. Cloudflare Worker status check
    let worker_url = storage::load_worker_url().ok().flatten();
    let auth_key = storage::load_status_auth_key().ok().flatten();

    if let (Some(url), Some(key)) = (worker_url, auth_key) {
        status.worker_deployed = true;
        let now_ms = Utc::now().timestamp_millis();
        let ledger_url = format!("{}/status?key={}&_t={}", url, key, now_ms);
        let resp = reqwest::Client::new()
            .get(&ledger_url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                status.worker_reachable = true;
                if let Ok(ledger) = r.json::<crate::commands::WorkerLedger>().await {
                    if let Some(ref circuit) = ledger.circuit_open_until_iso {
                        status.circuit_open = true;
                        status.worker_error = Some(format!(
                            "Worker circuit breaker active until {}",
                            circuit
                        ));
                    } else if ledger.stats.total_errors > 0 {
                        if let Some(ref err) = ledger.stats.last_error_message {
                            status.worker_error = Some(err.clone());
                        }
                    }
                }
            }
            Ok(r) => {
                status.worker_error = Some(format!("Worker status returned HTTP {}", r.status()));
            }
            Err(e) => {
                status.worker_error = Some(format!("Worker unreachable: {}", e));
            }
        }
    }

    status
}

pub async fn run_and_emit_health(app: &AppHandle) -> HealthStatus {
    let status = check_health().await;
    let _ = app.emit("health-status", &status);
    status
}

pub async fn maybe_notify_os(app: &AppHandle, status: &HealthStatus) {
    if let Some(days) = status.apple_days_remaining {
        if days <= 3 && days > 0 {
            let _ = app
                .notification()
                .builder()
                .title("aScrobble — Apple Music Token Expiring Soon")
                .body(format!(
                    "Your Apple Music token expires in {} day(s). Open aScrobble to rotate it.",
                    days
                ))
                .show();
        } else if days <= 0 {
            let _ = app
                .notification()
                .builder()
                .title("aScrobble — Apple Music Token Expired")
                .body("Your Apple Music token has expired. Open aScrobble to re-authenticate.")
                .show();
        }
    } else if status.apple_expired {
        let _ = app
            .notification()
            .builder()
            .title("aScrobble — Apple Music Token Expired")
            .body("Your Apple Music token has expired. Open aScrobble to re-authenticate.")
            .show();
    }

    if let Some(ref err) = status.worker_error {
        let _ = app
            .notification()
            .builder()
            .title("aScrobble — Scrobbler Alert")
            .body(err.clone())
            .show();
    }
}
