//! Secure credential storage using OS keyring with fallback file store.
//!
//! Wraps the `keyring` crate to store our credentials in the platform's
//! native credential store, backed up by an app-data credentials file.
//! On Windows, Windows Credential Manager enforces a strict 512-byte limit on
//! generic credentials. Large credentials (like Apple Music JWT tokens and
//! Cloudflare OAuth tokens) exceed 512 bytes and fail in Credential Manager.
//! To ensure 100% reliability across all operating systems, credentials are
//! mirrored in:
//!   %LOCALAPPDATA%/aScrobble/credentials.json (Windows)
//!   ~/.config/aScrobble/credentials.json (Linux)
//!   ~/Library/Application Support/aScrobble/credentials.json (macOS)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use anyhow::{anyhow, Result};
use keyring::Entry;

use crate::commands::{AppleTokens, CloudflareOauth, LastfmSession, UserSettings};

const SERVICE: &str = "dev.ascrobble.app";

// Distinct keys within keyring and fallback store
const KEY_APPLE: &str = "apple-tokens";
const KEY_LASTFM: &str = "lastfm-session";
const KEY_CF_TOKEN: &str = "cloudflare-token";
const KEY_CF_OAUTH: &str = "cloudflare-oauth";
const KEY_CF_ACCOUNT: &str = "cloudflare-account-id";
const KEY_STATUS_AUTH: &str = "status-auth-key";
const KEY_USER_SETTINGS: &str = "user-settings";
const KEY_WORKER_URL: &str = "worker-url";

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn entry(user: &str) -> Result<Entry> {
    Entry::new(SERVICE, user).map_err(|e| anyhow!("Failed to access keyring: {}", e))
}

pub fn get_app_data_dir() -> Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .map(PathBuf::from)
            .map_err(|_| anyhow!("Could not find LOCALAPPDATA or APPDATA environment variables"))?
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").map_err(|_| anyhow!("Could not find HOME environment variable"))?;
        PathBuf::from(home).join("Library").join("Application Support")
    } else {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            PathBuf::from(xdg)
        } else {
            let home = std::env::var("HOME").map_err(|_| anyhow!("Could not find HOME environment variable"))?;
            PathBuf::from(home).join(".local").join("share")
        }
    };

    let app_dir = base.join("aScrobble");
    if !app_dir.exists() {
        let _ = std::fs::create_dir_all(&app_dir);
    }
    Ok(app_dir)
}

fn get_fallback_json_path() -> Result<PathBuf> {
    Ok(get_app_data_dir()?.join("credentials.json"))
}

fn load_fallback_map() -> HashMap<String, String> {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = match get_fallback_json_path() {
        Ok(p) => p,
        Err(_) => return HashMap::new(),
    };
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_fallback_val(key: &str, value: Option<&str>) {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = match get_fallback_json_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let mut map = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    match value {
        Some(v) => {
            map.insert(key.to_string(), v.to_string());
        }
        None => {
            map.remove(key);
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(path, json);
    }
}

fn write_val(user: &str, value: &str) -> Result<()> {
    // 1. Always save to fallback file store
    save_fallback_val(user, Some(value));

    // 2. Best-effort write to OS keyring if value is within safe Credential Manager limits
    if value.len() <= 400 {
        if let Ok(e) = entry(user) {
            let _ = e.set_password(value);
        }
    }
    Ok(())
}

fn read_val(user: &str) -> Result<Option<String>> {
    // 1. Try keyring first
    if let Ok(e) = entry(user) {
        if let Ok(s) = e.get_password() {
            if !s.is_empty() {
                return Ok(Some(s));
            }
        }
    }

    // 2. Fall back to app-data credentials store
    let map = load_fallback_map();
    if let Some(val) = map.get(user) {
        if !val.is_empty() {
            return Ok(Some(val.clone()));
        }
    }

    Ok(None)
}

fn delete_val(user: &str) -> Result<()> {
    save_fallback_val(user, None);
    if let Ok(e) = entry(user) {
        let _ = e.delete_credential();
    }
    Ok(())
}

// ---------- Apple ----------

pub fn save_apple_tokens(tokens: &AppleTokens) -> Result<()> {
    let json = serde_json::to_string(tokens)?;
    write_val(KEY_APPLE, &json)
}

pub fn load_apple_tokens() -> Result<Option<AppleTokens>> {
    match read_val(KEY_APPLE)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

// ---------- Last.fm ----------

pub fn save_lastfm_session(session: &LastfmSession) -> Result<()> {
    let json = serde_json::to_string(session)?;
    write_val(KEY_LASTFM, &json)
}

pub fn load_lastfm_session() -> Result<Option<LastfmSession>> {
    match read_val(KEY_LASTFM)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

// ---------- Cloudflare ----------

pub fn save_cloudflare_token(token: &str) -> Result<()> {
    write_val(KEY_CF_TOKEN, token)
}

pub fn load_cloudflare_token() -> Result<Option<String>> {
    read_val(KEY_CF_TOKEN)
}

pub fn save_cloudflare_oauth(oauth: &CloudflareOauth) -> Result<()> {
    let json = serde_json::to_string(oauth)?;
    write_val(KEY_CF_OAUTH, &json)
}

pub fn load_cloudflare_oauth() -> Result<Option<CloudflareOauth>> {
    match read_val(KEY_CF_OAUTH)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

pub fn clear_cloudflare_oauth() -> Result<()> {
    delete_val(KEY_CF_OAUTH)
}

pub fn save_cloudflare_account_id(account_id: &str) -> Result<()> {
    write_val(KEY_CF_ACCOUNT, account_id)
}

pub fn load_cloudflare_account_id() -> Result<Option<String>> {
    read_val(KEY_CF_ACCOUNT)
}

// ---------- Worker status auth key ----------

pub fn save_status_auth_key(key: &str) -> Result<()> {
    write_val(KEY_STATUS_AUTH, key)
}

pub fn load_status_auth_key() -> Result<Option<String>> {
    read_val(KEY_STATUS_AUTH)
}

// ---------- User settings ----------

pub fn save_user_settings(settings: &UserSettings) -> Result<()> {
    let json = serde_json::to_string(settings)?;
    write_val(KEY_USER_SETTINGS, &json)
}

pub fn load_user_settings() -> Result<UserSettings> {
    match read_val(KEY_USER_SETTINGS)? {
        None => Ok(UserSettings::default()),
        Some(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
    }
}

// ---------- Worker URL ----------

pub fn save_worker_url(url: &str) -> Result<()> {
    write_val(KEY_WORKER_URL, url)
}

pub fn load_worker_url() -> Result<Option<String>> {
    read_val(KEY_WORKER_URL)
}

// ---------- Clear all ----------

pub fn clear_all() -> Result<()> {
    delete_val(KEY_APPLE)?;
    delete_val(KEY_LASTFM)?;
    delete_val(KEY_CF_TOKEN)?;
    delete_val(KEY_CF_OAUTH)?;
    delete_val(KEY_CF_ACCOUNT)?;
    delete_val(KEY_STATUS_AUTH)?;
    delete_val(KEY_USER_SETTINGS)?;
    delete_val(KEY_WORKER_URL)?;
    Ok(())
}
