//! amusic — desktop wizard for deploying an Apple Music → Last.fm scrobbler
//! to the user's own Cloudflare Workers account.
//!
//! The desktop app is a one-shot tool. It captures credentials for:
//!   1. Apple Music (via an embedded webview loading music.apple.com)
//!   2. Last.fm (via RFC 8252 loopback OAuth)
//!   3. Cloudflare (via a pasted API token)
//!
//! Then it uploads the bundled worker.js to the user's Cloudflare account
//! with a 5-minute cron trigger, writes credentials as Worker secrets, and
//! seeds the KV ledger. After that the app can be closed and the scrobbler
//! runs forever on Cloudflare.

mod auth;
mod commands;
mod deploy;
mod storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        // Prevent multiple copies of the app running simultaneously
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // If the user re-launches, focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())       // open browser for Last.fm auth
        .plugin(tauri_plugin_store::Builder::new().build()) // non-secret state
        .plugin(tauri_plugin_oauth::init())       // localhost loopback for Last.fm

        .invoke_handler(tauri::generate_handler![
            // Apple Music
            commands::apple_start_auth,
            commands::apple_get_tokens,
            commands::apple_cancel_auth,

            // Last.fm
            commands::lastfm_start_auth,
            commands::lastfm_cancel_auth,

            // Cloudflare
            commands::cloudflare_validate_token,
            commands::cloudflare_list_accounts,
            commands::cloudflare_oauth_login,
            commands::cloudflare_oauth_logout,
            commands::cloudflare_save_credentials,
            commands::cloudflare_save_account_id,
            commands::cloudflare_template_url,

            // Credential storage
            commands::storage_get_all,
            commands::storage_clear_all,

            // Settings
            commands::save_user_settings,
            commands::load_user_settings,

            // Deployment
            commands::deploy_worker,
            commands::deploy_status,
            commands::rotate_apple_tokens,
            commands::get_worker_url,
            commands::get_status_auth_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running amusic");
}
