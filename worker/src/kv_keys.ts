/**
 * KV key constants used by both the worker and the desktop deploy module.
 *
 * These keys live in the AMUSIC_STATE KV namespace alongside the ledger.
 * Apple tokens are stored in KV (not as worker secrets) so the desktop
 * app can rotate them without redeploying the worker.
 *
 * Underscore-separated (no colons or other special characters) so they're
 * safe in Cloudflare KV REST API URL path segments — the desktop app uses
 * `PUT /accounts/{id}/storage/kv/namespaces/{ns}/values/{key}` to seed and
 * rotate these.
 *
 * If you change these constants, you must also update the matching
 * constants in src-tauri/src/deploy.rs.
 */
export const KV_KEY_APPLE_DEV_TOKEN = "apple_dev_token";
export const KV_KEY_APPLE_USER_TOKEN = "apple_user_token";
