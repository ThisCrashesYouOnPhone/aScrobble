//! Apple Music authentication.
//!
//! There is no public OAuth flow for Apple Music. The approach used by
//! Cider and similar projects — and the only one that works for a
//! non-ADP-member tool — is to embed a webview loading music.apple.com
//! and capture `MusicKit.getInstance().developerToken` and
//! `.musicUserToken` once the user has signed in.
//!
//! Mechanism:
//!   1. Spawn a webview window navigating to https://music.apple.com with
//!      a spoofed Safari user-agent (Apple's player works with any modern
//!      browser UA; we avoid "wry" or "Tauri" appearing in the UA).
//!   2. Inject an initialization_script that polls
//!      `window.MusicKit?.getInstance?.()` every 500ms.
//!   3. Once both tokens are present and `isAuthorized` is true, the
//!      script navigates the window to a reserved sentinel URL
//!      `https://ascrobble-capture.invalid/?dev=...&mut=...`.
//!   4. Our `on_navigation` callback intercepts that sentinel, extracts
//!      the tokens from the query string, cancels the navigation, and
//!      delivers them via a oneshot channel back to the waiting command.
//!
//! Fallback: if the sentinel approach ever stops working (e.g., Apple
//! tightens something), we have a paste-manually flow that shows the
//! JS one-liner the user can run in their own browser console.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chrono::Utc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::commands::AppleTokens;
use crate::storage;

const WINDOW_LABEL: &str = "apple-auth";
const AUTH_TIMEOUT_SECS: u64 = 600; // 10 min — generous for 2FA flows
const CAPTURE_HOST: &str = "ascrobble-capture.invalid";

/// Modern Safari user-agent. Critical that this does NOT contain "wry" or
/// "Tauri" — Apple's MusicKit JS does UA sniffing in places and anything
/// unusual gets 403'd.
const SPOOF_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15";

/// Polled in the webview context. Runs as the initialization_script, so it
/// executes before music.apple.com's own scripts on every real navigation.
/// Uses a window-level guard flag to avoid creating duplicate poll loops
/// when init_script fires twice (e.g., after the Apple ID redirect back).
const POLL_SCRIPT: &str = r#"
(function() {
  if (window.__ascrobblePolling) return;
  window.__ascrobblePolling = true;
  var attempts = 0;
  function poll() {
    attempts++;
    if (attempts > 1200) return; // ~10 min cap
    try {
      var mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
      if (mk && mk.developerToken && mk.musicUserToken && mk.isAuthorized) {
        var url = "https://ascrobble-capture.invalid/?" +
          "dev=" + encodeURIComponent(mk.developerToken) +
          "&mut=" + encodeURIComponent(mk.musicUserToken);
        window.location.href = url;
        return; // stop polling — navigation will be intercepted
      }
    } catch (e) {}
    setTimeout(poll, 500);
  }
  setTimeout(poll, 1500); // give MusicKit a moment to initialize
})();
"#;

type AuthResult = Result<AppleTokens, String>;
type AuthSender = oneshot::Sender<AuthResult>;

/// Global slot holding the in-progress auth flow's sender.
/// Only one flow can be active at a time — starting a new one cancels the old.
static SLOT: OnceLock<Mutex<Option<AuthSender>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<AuthSender>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Spawn the Apple Music auth window and wait for the user to complete sign-in.
/// Returns the captured tokens, or an error if the flow timed out or was cancelled.
pub async fn start_auth_flow(app: &AppHandle) -> Result<AppleTokens> {
    // Cancel any previous in-progress flow
    let _ = cancel_auth_flow(app).await;

    let (tx, rx) = oneshot::channel::<AuthResult>();
    *slot().lock().await = Some(tx);

    let app_clone = app.clone();
    let start_url: Url = "https://music.apple.com/".parse()?;

    WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(start_url),
    )
    .title("Sign in to Apple Music")
    .inner_size(1100.0, 780.0)
    .center()
    .user_agent(SPOOF_UA)
    .initialization_script(POLL_SCRIPT)
    .on_navigation(move |url: &Url| -> bool {
        if url.host_str() != Some(CAPTURE_HOST) {
            return true; // allow all non-sentinel navigations
        }

        // Sentinel URL hit — extract tokens from the query string
        let mut dev: Option<String> = None;
        let mut mut_tok: Option<String> = None;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "dev" => dev = Some(v.into_owned()),
                "mut" => mut_tok = Some(v.into_owned()),
                _ => {}
            }
        }

        if let (Some(developer_token), Some(music_user_token)) = (dev, mut_tok) {
            let app_handle = app_clone.clone();
            tauri::async_runtime::spawn(async move {
                let tokens = AppleTokens {
                    developer_token,
                    music_user_token,
                    captured_at: Utc::now().to_rfc3339(),
                    expires_at: None,
                }.with_decoded_expiry();

                // Persist to OS keychain immediately
                log::info!("Saving Apple tokens to keychain...");
                let save_result = storage::save_apple_tokens(&tokens);
                match &save_result {
                    Ok(()) => log::info!("✓ Apple tokens saved to keychain successfully"),
                    Err(e) => log::error!("✗ Failed to save apple tokens: {e}"),
                }

                // Deliver to the waiting start_auth_flow future
                if let Some(sender) = slot().lock().await.take() {
                    let _ = match save_result {
                        Ok(()) => sender.send(Ok(tokens)),
                        Err(e) => sender.send(Err(format!(
                            "Failed to save Apple tokens to keychain: {}",
                            e
                        ))),
                    };
                }

                // Close the auth window
                if let Some(w) = app_handle.get_webview_window(WINDOW_LABEL) {
                    let _ = w.close();
                }
            });
        }

        false // always cancel the sentinel navigation
    })
    .build()?;

    // Wait for either capture, timeout, or cancellation
    let received = tokio::time::timeout(Duration::from_secs(AUTH_TIMEOUT_SECS), rx)
        .await
        .map_err(|_| anyhow!("Apple sign-in timed out (10 minutes). Please try again."))?
        .map_err(|_| anyhow!("Apple sign-in was cancelled."))?;

    received.map_err(|e| anyhow!("{}", e))
}

/// Cancel the current auth flow, closing the window and resolving the
/// pending future (if any) with a cancellation error.
pub async fn cancel_auth_flow(app: &AppHandle) -> Result<()> {
    if let Some(sender) = slot().lock().await.take() {
        let _ = sender.send(Err("cancelled".to_string()));
    }
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.close();
    }
    Ok(())
}
