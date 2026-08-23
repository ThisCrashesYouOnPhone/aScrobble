//! aScrobble — desktop wizard for deploying an Apple Music → Last.fm scrobbler
//! to the user's own Cloudflare Workers account.

mod auth;
mod commands;
mod deploy;
mod health;
mod storage;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        // Prevent multiple copies of the app running simultaneously
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // If the user re-launches, focus and unhide the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())       // open browser for Last.fm auth
        .plugin(tauri_plugin_store::Builder::new().build()) // non-secret state
        .plugin(tauri_plugin_oauth::init())       // localhost loopback for Last.fm
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::AppleScript,
            Some(vec!["--minimized"]),
        ))

        .setup(|app| {
            // Build system tray menu
            let show_item = MenuItem::with_id(app, "show", "Show aScrobble", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit aScrobble", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut builder = TrayIconBuilder::new().menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }

            let _tray = builder
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // If launched with --minimized (e.g. system boot), hide window immediately
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--minimized".to_string()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Spawn proactive health check task (immediate check on boot + every 6 hours)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let status = health::run_and_emit_health(&handle).await;
                health::maybe_notify_os(&handle, &status).await;

                let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
                loop {
                    interval.tick().await;
                    let status = health::run_and_emit_health(&handle).await;
                    health::maybe_notify_os(&handle, &status).await;
                }
            });

            Ok(())
        })

        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let settings = storage::load_user_settings().unwrap_or_default();
                if settings.minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })

        .invoke_handler(tauri::generate_handler![
            // Apple Music
            commands::apple_start_auth,
            commands::apple_get_tokens,
            commands::apple_cancel_auth,
            commands::apple_decode_token_expiry,

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

            // Health Status
            commands::get_health_status,

            // Deployment
            commands::deploy_worker,
            commands::deploy_status,
            commands::get_worker_status,
            commands::rotate_apple_tokens,
            commands::get_worker_url,
            commands::get_status_auth_key,
            
            // Debug
            commands::debug_export_apple_tokens,
            commands::open_data_folder,
            commands::get_app_logs,
            commands::save_log_file,
            commands::export_full_diagnostics,
            commands::update_poll_interval,
            commands::reset_worker_stats,
            commands::redeploy_worker,
        ])
        .run(tauri::generate_context!())
        .expect("error while running aScrobble");
}
