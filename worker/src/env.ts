/**
 * Cloudflare Worker environment bindings.
 *
 * Secrets are set via the desktop app's deploy flow (or `wrangler secret put`
 * for local dev). KV namespaces are bound in wrangler.toml.
 *
 * Apple tokens are intentionally NOT in env. They live in KV under the
 * `apple:dev_token` and `apple:user_token` keys so the desktop app can
 * rotate them without redeploying the worker (worker secrets are
 * immutable per deploy in Cloudflare's model — KV values are mutable).
 */
export interface Env {
  // KV: persistent ledger state AND rotatable Apple tokens
  ASCROBBLE_STATE: KVNamespace;

  // Last.fm (from Last.fm API account + user auth)
  LASTFM_API_KEY: string;
  LASTFM_SHARED_SECRET: string;
  LASTFM_SESSION_KEY: string;

  // Optional: ListenBrainz user token for dual-target scrobbling
  LISTENBRAINZ_TOKEN?: string;

  // Optional: Discord/Slack webhook for push notifications
  NOTIFY_WEBHOOK_URL?: string;

  // Required: shared secret protecting the /status and /trigger endpoints
  // so random traffic to the workers.dev URL can't snoop on the user's data
  STATUS_AUTH_KEY: string;

  // Non-secret config
  LOG_LEVEL?: string;
}

/** Single ledger row — Apple's view of a recently-played track. */
export interface AppleTrack {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration_ms: number;
  isrc?: string;
}

/** A detected play, before or after timestamp assignment. */
export interface DetectedPlay {
  track: AppleTrack;
  kind: "new" | "repeat";
  timestamp?: Date; // assigned by timestamps.ts
}

/** Canonical scrobble payload shared between Last.fm and ListenBrainz clients. */
export interface ScrobblePayload {
  artist: string;
  track: string;
  album: string;
  timestamp: Date;
  duration_ms: number;
}
