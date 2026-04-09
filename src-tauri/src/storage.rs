//! Secure credential storage using the OS keyring.
//!
//! Wraps the `keyring` crate to store our credentials in the platform's
//! native credential store:
//!   * macOS: Keychain
//!   * Windows: Credential Manager
//!   * Linux: Secret Service (GNOME Keyring / KWallet)
//!
//! All credentials are serialized as JSON strings and stored under the
//! service name "dev.amusic.app" with a distinct "user" per credential type.

use anyhow::{anyhow, Result};
use keyring::Entry;

use crate::commands::{AppleTokens, CloudflareOauth, LastfmSession, UserSettings};

const SERVICE: &str = "dev.amusic.app";

// Distinct "user" slots within the keyring
const KEY_APPLE: &str = "apple-tokens";
const KEY_LASTFM: &str = "lastfm-session";
const KEY_CF_TOKEN: &str = "cloudflare-token";
const KEY_CF_OAUTH: &str = "cloudflare-oauth";
const KEY_CF_ACCOUNT: &str = "cloudflare-account-id";
// The shared secret that auths the deployed worker's /status and /trigger
// endpoints. Randomly generated per deploy, stored both here and as the
// STATUS_AUTH_KEY worker secret on Cloudflare.
const KEY_STATUS_AUTH: &str = "status-auth-key";
const KEY_USER_SETTINGS: &str = "user-settings";

fn entry(user: &str) -> Result<Entry> {
    Entry::new(SERVICE, user).map_err(|e| anyhow!("Failed to access keyring: {}", e))
}

/// Treat "no entry found" as None rather than error, since the app starts
/// with everything empty and we want to distinguish "not set" from "broken".
fn read_optional(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("Failed to read from keyring: {}", e)),
    }
}

fn write(entry: &Entry, value: &str) -> Result<()> {
    entry
        .set_password(value)
        .map_err(|e| anyhow!("Failed to write to keyring: {}", e))?;

    // Immediately verify read-back so silent backend failures are surfaced
    // at the step where they occur instead of later at deploy gating.
    let persisted = entry
        .get_password()
        .map_err(|e| anyhow!("Wrote to keyring but failed to read back: {}", e))?;

    if persisted != value {
        return Err(anyhow!(
            "Keyring write verification failed: value mismatch after write"
        ));
    }

    Ok(())
}

fn delete_if_exists(entry: &Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("Failed to clear keyring entry: {}", e)),
    }
}

// ---------- Apple ----------

pub fn save_apple_tokens(tokens: &AppleTokens) -> Result<()> {
    let json = serde_json::to_string(tokens)?;
    write(&entry(KEY_APPLE)?, &json)
}

pub fn load_apple_tokens() -> Result<Option<AppleTokens>> {
    match read_optional(&entry(KEY_APPLE)?)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

// ---------- Last.fm ----------

pub fn save_lastfm_session(session: &LastfmSession) -> Result<()> {
    let json = serde_json::to_string(session)?;
    write(&entry(KEY_LASTFM)?, &json)
}

pub fn load_lastfm_session() -> Result<Option<LastfmSession>> {
    match read_optional(&entry(KEY_LASTFM)?)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

// ---------- Cloudflare ----------

pub fn save_cloudflare_token(token: &str) -> Result<()> {
    write(&entry(KEY_CF_TOKEN)?, token)
}

pub fn load_cloudflare_token() -> Result<Option<String>> {
    read_optional(&entry(KEY_CF_TOKEN)?)
}

pub fn save_cloudflare_oauth(oauth: &CloudflareOauth) -> Result<()> {
    let json = serde_json::to_string(oauth)?;
    write(&entry(KEY_CF_OAUTH)?, &json)
}

pub fn load_cloudflare_oauth() -> Result<Option<CloudflareOauth>> {
    match read_optional(&entry(KEY_CF_OAUTH)?)? {
        None => Ok(None),
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
    }
}

pub fn clear_cloudflare_oauth() -> Result<()> {
    delete_if_exists(&entry(KEY_CF_OAUTH)?)
}

pub fn save_cloudflare_account_id(account_id: &str) -> Result<()> {
    write(&entry(KEY_CF_ACCOUNT)?, account_id)
}

pub fn load_cloudflare_account_id() -> Result<Option<String>> {
    read_optional(&entry(KEY_CF_ACCOUNT)?)
}

// ---------- Worker status auth key ----------

pub fn save_status_auth_key(key: &str) -> Result<()> {
    write(&entry(KEY_STATUS_AUTH)?, key)
}

#[allow(dead_code)]
pub fn load_status_auth_key() -> Result<Option<String>> {
    read_optional(&entry(KEY_STATUS_AUTH)?)
}

// ---------- User settings ----------

pub fn save_user_settings(settings: &UserSettings) -> Result<()> {
    let json = serde_json::to_string(settings)?;
    write(&entry(KEY_USER_SETTINGS)?, &json)
}

pub fn load_user_settings() -> Result<UserSettings> {
    match read_optional(&entry(KEY_USER_SETTINGS)?)? {
        None => Ok(UserSettings::default()),
        Some(s) => Ok(serde_json::from_str(&s)?),
    }
}

// ---------- Clear all ----------

pub fn clear_all() -> Result<()> {
    delete_if_exists(&entry(KEY_APPLE)?)?;
    delete_if_exists(&entry(KEY_LASTFM)?)?;
    delete_if_exists(&entry(KEY_CF_TOKEN)?)?;
    delete_if_exists(&entry(KEY_CF_OAUTH)?)?;
    delete_if_exists(&entry(KEY_CF_ACCOUNT)?)?;
    delete_if_exists(&entry(KEY_STATUS_AUTH)?)?;
    delete_if_exists(&entry(KEY_USER_SETTINGS)?)?;
    Ok(())
}
