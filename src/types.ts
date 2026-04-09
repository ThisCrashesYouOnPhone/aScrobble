// Mirror of the DTOs in src-tauri/src/commands.rs
// Keep these in sync if you add/change fields on the Rust side.

export interface AppleTokens {
  developer_token: string;
  music_user_token: string;
  captured_at: string; // ISO-8601
}

export interface LastfmSession {
  session_key: string;
  username: string;
  api_key: string;
  shared_secret: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareOauth {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

export interface StoredCredentials {
  apple: AppleTokens | null;
  lastfm: LastfmSession | null;
  cloudflare_oauth: CloudflareOauth | null;
  cloudflare_token: string | null;
  cloudflare_account_id: string | null;
}

export interface DeployStatus {
  deployed: boolean;
  worker_name: string | null;
  last_run_iso: string | null;
  total_scrobbled: number;
  total_runs: number;
}

export interface UserSettings {
  poll_interval_minutes: number; // 1, 2, 5, 10, 15, or 30
}

export type WizardStep = "welcome" | "apple" | "lastfm" | "cloudflare" | "deploy" | "done";
