// Typed wrappers around the Tauri command surface defined in
// src-tauri/src/commands.rs.
//
// CONVENTION: Tauri 2 auto-converts JS camelCase keys to Rust snake_case
// argument names. So a Rust command `fn foo(account_id: String)` is invoked
// from JS as `invoke("foo", { accountId: "..." })`.
//
// The frontend NEVER calls invoke() directly; all calls go through this
// file so types stay in sync and refactors touch one place.

import { invoke } from "@tauri-apps/api/core";
import type {
  AppleTokens,
  LastfmSession,
  CloudflareAccount,
  CloudflareOauth,
  StoredCredentials,
  DeployStatus,
  UserSettings,
  WorkerLedger,
} from "../types";

// ---------- Apple Music ----------

export const appleStartAuth = (): Promise<AppleTokens> =>
  invoke("apple_start_auth");

export const appleGetTokens = (): Promise<AppleTokens | null> =>
  invoke("apple_get_tokens");

export const appleCancelAuth = (): Promise<void> =>
  invoke("apple_cancel_auth");

export const appleDecodeTokenExpiry = (developerToken: string): Promise<string | null> =>
  invoke("apple_decode_token_expiry", { developerToken });

// ---------- Last.fm ----------

export const lastfmStartAuth = (
  apiKey: string,
  sharedSecret: string
): Promise<LastfmSession> =>
  invoke("lastfm_start_auth", { apiKey, sharedSecret });

export const lastfmCancelAuth = (): Promise<void> =>
  invoke("lastfm_cancel_auth");

// ---------- Cloudflare ----------

export const cloudflareValidateToken = (token: string): Promise<boolean> =>
  invoke("cloudflare_validate_token", { token });

export const cloudflareListAccounts = (
  token: string
): Promise<CloudflareAccount[]> =>
  invoke("cloudflare_list_accounts", { token });

export const cloudflareOauthLogin = (): Promise<CloudflareOauth> =>
  invoke("cloudflare_oauth_login");

export const cloudflareOauthLogout = (): Promise<void> =>
  invoke("cloudflare_oauth_logout");

export const cloudflareSaveCredentials = (
  token: string,
  accountId: string
): Promise<void> =>
  invoke("cloudflare_save_credentials", { token, accountId });

export const cloudflareSaveAccountId = (accountId: string): Promise<void> =>
  invoke("cloudflare_save_account_id", { accountId });

export const cloudflareTemplateUrl = (): Promise<string> =>
  invoke("cloudflare_template_url");

// ---------- Storage ----------

export const storageGetAll = (): Promise<StoredCredentials> =>
  invoke("storage_get_all");

export const storageClearAll = (): Promise<void> =>
  invoke("storage_clear_all");

// ---------- Deployment ----------

export const saveUserSettings = (settings: UserSettings): Promise<void> =>
  invoke("save_user_settings", { settings });

export const loadUserSettings = (): Promise<UserSettings> =>
  invoke("load_user_settings");

export const deployWorker = (
  accountId: string,
  pollIntervalMinutes: number,
  listenbrainzToken?: string,
  webhookUrl?: string,
): Promise<string> =>
  invoke("deploy_worker", { accountId, pollIntervalMinutes, listenbrainzToken, webhookUrl });

export const deployStatus = (accountId: string): Promise<DeployStatus> =>
  invoke("deploy_status", { accountId });

export const rotateAppleTokens = (accountId: string): Promise<void> =>
  invoke("rotate_apple_tokens", { accountId });

export const getWorkerUrl = (): Promise<string | null> =>
  invoke("get_worker_url");

export const getStatusAuthKey = (): Promise<string | null> =>
  invoke("get_status_auth_key");

export const getWorkerStatus = (): Promise<WorkerLedger> =>
  invoke("get_worker_status");
