/**
 * Orchestrator: poll Apple → detect plays → assign timestamps → submit → persist.
 *
 * Ported from v1/apple_scrobbler/main.py. Called from both:
 *   - the scheduled() handler (cron firing every minute)
 *   - the /trigger endpoint (manual runs from the desktop app)
 *
 * Apple tokens are read from KV (not env) so the desktop app can rotate
 * them without redeploying the worker. See kv_keys.ts for the key names.
 *
 * Protections built in:
 *   - Circuit breaker: after 5 consecutive errors, pause polling for 30 min
 *     then use exponential backoff (30 → 60 → 120 min) for further failures.
 *   - Scrobble dedup guard: per-track ID + 10-min bucket prevents burst duplicates
 *     if the ledger gets wiped and the bootstrap snapshot is skipped.
 *   - Apple token expired: trips circuit breaker + fires webhook notification.
 *   - Missing KV tokens: trips circuit breaker immediately.
 */
import type { Env, ScrobblePayload } from "./env";
import { fetchRecentlyPlayed, fetchTrackPlayCount, TokenExpiredError } from "./apple";
import { detectPlays } from "./detect";
import { assignTimestamps } from "./timestamps";
import { scrobbleBatch } from "./lastfm";
import { submitBatch as submitToListenBrainz } from "./listenbrainz";
import {
  notifyTokenExpired,
  notifyMilestone,
  notifySummary,
} from "./notify";
import {
  loadLedger,
  saveLedger,
  parseLastRunTime,
  addRecentScrobbles,
  addLogEntry,
  type LedgerData,
} from "./ledger";
import { KV_KEY_APPLE_DEV_TOKEN, KV_KEY_APPLE_USER_TOKEN } from "./kv_keys";

// ─── Circuit breaker config ───────────────────────────────────────────────────
/** Number of consecutive errors before the circuit opens. */
const CB_ERROR_THRESHOLD = 5;
/** Base cooldown on first open (ms). Doubles each time the circuit re-opens. */
const CB_BASE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
/** Token-expired errors trip the circuit immediately (skip straight to open). */
const CB_INSTANT_TRIP_ERRORS = new Set(["apple_token_expired", "apple_tokens_missing_in_kv"]);
/** Maximum cooldown cap (2 h). */
const CB_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// ─── Scrobble dedup config ────────────────────────────────────────────────────
/** Window (ms) within which the exact same track won't be re-scrobbled (burst guard). */
const DEDUP_WINDOW_MS = 30 * 1000; // 30 seconds
/** Max entries kept in the dedup list (safety cap). */
const DEDUP_MAX_ENTRIES = 200;

export interface RunSummary {
  ok: boolean;
  detected: number;
  accepted: number;
  ignored: number;
  errors: number;
  repeat_count: number;
  elapsed_ms: number;
  error_message?: string;
  circuit_open?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCircuitOpen(ledger: LedgerData, now: number): boolean {
  if (!ledger.circuit_open_until_iso) return false;
  return now < new Date(ledger.circuit_open_until_iso).getTime();
}

function openCircuit(ledger: LedgerData, now: number): void {
  // Exponential back-off: each successive open doubles the cooldown.
  const opens = ledger.consecutive_errors ?? CB_ERROR_THRESHOLD;
  const multiplier = Math.pow(2, Math.max(0, Math.floor(opens / CB_ERROR_THRESHOLD) - 1));
  const cooldown = Math.min(CB_BASE_COOLDOWN_MS * multiplier, CB_MAX_COOLDOWN_MS);
  ledger.circuit_open_until_iso = new Date(now + cooldown).toISOString();
  console.warn(
    `Circuit breaker OPEN — pausing polls for ${Math.round(cooldown / 60_000)} min` +
      ` (consecutive_errors=${ledger.consecutive_errors})`
  );
}

function resetCircuit(ledger: LedgerData): void {
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = undefined;
}

function dedupKey(trackId: string, bucketMs: number): string {
  const bucket = Math.floor(bucketMs / DEDUP_WINDOW_MS);
  return `${trackId}:${bucket}`;
}

function pruneDedup(ledger: LedgerData, now: number): void {
  if (!ledger.recent_scrobble_ids) return;
  const cutoff = Math.floor((now - DEDUP_WINDOW_MS) / DEDUP_WINDOW_MS);
  ledger.recent_scrobble_ids = ledger.recent_scrobble_ids
    .filter((k) => {
      const bucket = parseInt(k.split(":")[1] ?? "0", 10);
      return bucket > cutoff;
    })
    .slice(0, DEDUP_MAX_ENTRIES);
}

function isDuplicate(ledger: LedgerData, trackId: string, now: number): boolean {
  if (!ledger.recent_scrobble_ids) return false;
  return ledger.recent_scrobble_ids.includes(dedupKey(trackId, now));
}

function recordScrobbled(ledger: LedgerData, trackId: string, now: number): void {
  if (!ledger.recent_scrobble_ids) ledger.recent_scrobble_ids = [];
  ledger.recent_scrobble_ids.push(dedupKey(trackId, now));
}

// ─── Abort helper ─────────────────────────────────────────────────────────────

async function failRun(
  env: Env,
  ledger: LedgerData,
  runTime: Date,
  startedAt: number,
  errorMessage: string,
  instantTrip = false
): Promise<RunSummary> {
  ledger.stats.total_errors += 1;
  ledger.stats.last_error_iso = runTime.toISOString();
  ledger.stats.last_error_message = errorMessage;

  ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
  const shouldOpen =
    instantTrip ||
    CB_INSTANT_TRIP_ERRORS.has(errorMessage) ||
    ledger.consecutive_errors >= CB_ERROR_THRESHOLD;

  if (shouldOpen && !isCircuitOpen(ledger, startedAt)) {
    openCircuit(ledger, startedAt);
  }

  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return {
    ok: false,
    detected: 0,
    accepted: 0,
    ignored: 0,
    errors: 1,
    repeat_count: 0,
    elapsed_ms: Date.now() - startedAt,
    error_message: errorMessage,
    circuit_open: isCircuitOpen(ledger, startedAt),
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function pollAndScrobble(env: Env, isManual = false): Promise<RunSummary> {
  const startedAt = Date.now();
  const runTime = new Date(startedAt);

  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  const lastRunTime = parseLastRunTime(ledger);

  ledger.stats.total_runs += 1;
  ledger.last_run_iso = runTime.toISOString();

  addLogEntry(ledger, "poll_start", `Run #${ledger.stats.total_runs} started${isManual ? " (manual)" : ""} · elapsed since last: ${lastRunTime ? Math.round((startedAt - lastRunTime.getTime()) / 1000) + "s" : "first run"}`, "info");

  // If manual trigger from app, force reset open circuit breaker
  if (isManual) {
    resetCircuit(ledger);
    addLogEntry(ledger, "circuit_reset", "Manual trigger — circuit breaker reset", "info");
  }

  // ── Circuit breaker gate ───────────────────────────────────────────────────
  if (isCircuitOpen(ledger, startedAt)) {
    const until = new Date(ledger.circuit_open_until_iso!);
    const minLeft = Math.round((until.getTime() - startedAt) / 60_000);
    console.warn(
      `Circuit breaker is OPEN — skipping poll. Will retry after ${until.toISOString()}` +
        ` (${minLeft} min remaining)`
    );
    addLogEntry(ledger, "circuit_open", `Circuit open — skipping poll for ${minLeft}min more`, "error");
    // Still save so the dashboard can show the circuit state
    ledger.last_run_iso = runTime.toISOString(); // mark that we woke up
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    if (startedAt - lastSaveTime > 15 * 60 * 1000) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }
    return {
      ok: false,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
      circuit_open: true,
    };
  }

  // ── Read Apple tokens from KV ──────────────────────────────────────────────
  addLogEntry(ledger, "kv_token_read", "Reading Apple dev + user tokens from Cloudflare KV...", "info");
  const [appleDevToken, appleUserToken] = await Promise.all([
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_USER_TOKEN),
  ]);

  if (!appleDevToken || !appleUserToken) {
    const msg = "apple_tokens_missing_in_kv";
    console.error(
      `${msg}: expected keys ${KV_KEY_APPLE_DEV_TOKEN} and ${KV_KEY_APPLE_USER_TOKEN}`
    );
    addLogEntry(ledger, "kv_token_missing", "Apple tokens not found in KV — circuit tripped", "error");
    return failRun(env, ledger, runTime, startedAt, msg, /*instantTrip=*/true);
  }
  addLogEntry(ledger, "kv_token_ok", "Apple tokens found in KV ✓", "info");

  // ── 1. Fetch Apple recently-played ────────────────────────────────────────
  addLogEntry(ledger, "apple_fetch_start", "Calling Apple Music /v1/me/recent/played/tracks...", "info");
  let current;
  try {
    current = await fetchRecentlyPlayed(appleDevToken, appleUserToken);
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      console.error("Apple token expired — tripping circuit breaker");
      addLogEntry(ledger, "apple_token_expired", "Apple Music token returned 401 — circuit tripped", "error");
      await notifyTokenExpired(env.NOTIFY_WEBHOOK_URL);
      return failRun(env, ledger, runTime, startedAt, "apple_token_expired", /*instantTrip=*/true);
    }
    // Generic network / parse error — count toward threshold
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Apple API error:", msg);
    addLogEntry(ledger, "apple_fetch_error", `Apple API error: ${msg}`, "error");
    return failRun(env, ledger, runTime, startedAt, `apple_api_error: ${msg}`);
  }

  // On a successful Apple fetch, reset error counter, error messages & circuit
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;

  console.log(`Apple returned ${current.length} tracks`);
  addLogEntry(ledger, "apple_fetch_success", `Fetched ${current.length} recently played tracks from Apple API`, "info");

  // ── 2. Bootstrap protection: first run just snapshots, doesn't scrobble ───
  if (ledger.previous_recent.length === 0) {
    console.log(`First run — snapshotting ${current.length} tracks without scrobbling`);
    addLogEntry(ledger, "bootstrap_snapshot", `Snapshotting ${current.length} tracks on initial run`, "info");
    ledger.previous_recent = current;
    ledger.stats.last_success_iso = runTime.toISOString();
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // ── 3. Detect what's new since last poll ──────────────────────────────────
  const elapsedSeconds = lastRunTime
    ? Math.max(0, Math.round((startedAt - lastRunTime.getTime()) / 1000))
    : 180;
  const prevState = {
    stationaryIdle: ledger.stationary_idle ?? false,
    handledCount: ledger.handled_count ?? 1,
    position0ElapsedSec: ledger.position0_elapsed_sec ?? 0,
  };
  const detection = detectPlays(current, ledger.previous_recent, elapsedSeconds, prevState);
  const plays = detection.plays;
  ledger.stationary_idle = detection.newState.stationaryIdle;
  ledger.handled_count = detection.newState.handledCount;
  ledger.position0_elapsed_sec = detection.newState.position0ElapsedSec;

  // ── 3a. Position-0 silent repeat probe for library tracks ─────────────────
  if (plays.length === 0 && current.length > 0 && ledger.previous_recent.length > 0) {
    const topTrack = current[0];
    const prevTopTrack = ledger.previous_recent[0];

    if (topTrack.id === prevTopTrack.id && topTrack.isrc) {
      const newCount = await fetchTrackPlayCount(appleDevToken, appleUserToken, topTrack.isrc);
      if (newCount !== null) {
        const prevCount =
          ledger.top_track_id === topTrack.id ? ledger.top_track_play_count : undefined;
        if (prevCount !== undefined && newCount > prevCount) {
          const delta = newCount - prevCount;
          console.log(
            `Position-0 probe: play count for "${topTrack.name}" rose by ${delta} — emitting ${delta} silent repeat(s)`
          );
          addLogEntry(ledger, "repeat_probe_detected", `Library playCount rose by ${delta} for "${topTrack.name}"`, "success");
          for (let i = 0; i < delta; i++) {
            plays.push({ track: topTrack, kind: "repeat" });
          }
          ledger.stationary_idle = false;
        }
        ledger.top_track_id = topTrack.id;
        ledger.top_track_play_count = newCount;
      }
    } else {
      ledger.top_track_id = current[0]?.id;
      ledger.top_track_play_count = undefined;
    }
  }

  // ── 3b. Scrobble dedup guard ──────────────────────────────────────────────
  pruneDedup(ledger, startedAt);
  const deduped = plays.filter((p) => {
    const trackId = (p.track as any).id as string | undefined;
    if (!trackId) return true; // no ID → can't dedup, let it through
    if (isDuplicate(ledger, trackId, startedAt)) {
      console.warn(`Dedup guard: skipping "${p.track.name}" — already scrobbled in last 30s`);
      addLogEntry(ledger, "dedup_skipped", `Skipping duplicate play "${p.track.name}" within 30s window`, "warn");
      return false;
    }
    return true;
  });

  if (deduped.length === 0) {
    console.log("No new plays");
    ledger.previous_recent = current;
    const topTrackName = current[0]?.name ?? "None";
    addLogEntry(ledger, "poll_idle", `Checked ${current.length} Apple tracks — 0 new plays. Latest track in history: "${topTrackName}"`, "info");
    
    // KV Quota Guard: save idle state to KV once every 5 minutes (or when scrobbles occur)
    // 288 idle writes/day + scrobbles = ~388 writes/day (WELL BELOW Cloudflare's 1,000/day free limit!)
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    const shouldSave = !ledger.last_save_iso || (startedAt - lastSaveTime >= 5 * 60 * 1000);

    if (shouldSave) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }

    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  addLogEntry(ledger, "scrobble_detected", `Detected ${deduped.length} play(s): ${deduped.map(p => `"${p.track.name}"`).join(", ")}`, "success");

  const dedupDropped = plays.length - deduped.length;
  console.log(`Detected ${deduped.length} play(s) (${dedupDropped} deduped)`);

  // ── 4. Assign timestamps ──────────────────────────────────────────────────
  const timestamped = assignTimestamps(deduped, runTime, lastRunTime);

  for (const p of timestamped) {
    console.log(
      `  [${p.kind}] ${p.track.artist} — ${p.track.name} @ ${p.timestamp?.toISOString()}`
    );
  }

  // ── 5. Submit to Last.fm ──────────────────────────────────────────────────
  const payload: ScrobblePayload[] = timestamped.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp: p.timestamp!,
    duration_ms: p.track.duration_ms,
  }));

  addLogEntry(ledger, "lastfm_submit_start", `Submitting ${payload.length} scrobble(s) to Last.fm...`, "info");
  let lfmResult = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );

  // Retry once on a full-batch network failure. Last.fm deduplicates by
  // (artist, track, timestamp) so a double-submit is dropped server-side.
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    console.warn(`Last.fm: all ${lfmResult.errors} tracks failed — retrying after 1 s`);
    addLogEntry(ledger, "lastfm_submit_retry", `All ${lfmResult.errors} tracks failed — retrying in 1s...`, "warn");
    await new Promise((r) => setTimeout(r, 1_000));
    lfmResult = await scrobbleBatch(
      payload,
      env.LASTFM_API_KEY,
      env.LASTFM_SHARED_SECRET,
      env.LASTFM_SESSION_KEY
    );
  }

  console.log(
    `Last.fm: ${lfmResult.accepted} accepted, ${lfmResult.ignored} ignored, ${lfmResult.errors} errors`
  );
  addLogEntry(
    ledger,
    "lastfm_submit_done",
    `Last.fm: ${lfmResult.accepted} accepted · ${lfmResult.ignored} ignored · ${lfmResult.errors} errors`,
    lfmResult.accepted > 0 ? "success" : lfmResult.errors > 0 ? "error" : "info"
  );

  // ── 5a. Count Last.fm errors toward circuit breaker ───────────────────────
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    const msg = `lastfm_submit_failed (${lfmResult.errors} errors)`;
    console.error(msg);
    // Not instant-trip, but counts toward threshold
    ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
    addLogEntry(ledger, "circuit_error_count", `Consecutive errors: ${ledger.consecutive_errors}/${5}`, "warn");
    if (ledger.consecutive_errors >= CB_ERROR_THRESHOLD) {
      openCircuit(ledger, startedAt);
      addLogEntry(ledger, "circuit_tripped", `Circuit breaker tripped after ${CB_ERROR_THRESHOLD} consecutive errors`, "error");
    }
  }

  // ── 6. Optional: also submit to ListenBrainz ──────────────────────────────
  if (env.LISTENBRAINZ_TOKEN) {
    addLogEntry(ledger, "listenbrainz_submit", "Also submitting to ListenBrainz...", "info");
    const lbResult = await submitToListenBrainz(payload, env.LISTENBRAINZ_TOKEN);
    console.log(
      `ListenBrainz: ${lbResult.accepted} accepted, ${lbResult.errors} errors`
    );
    addLogEntry(ledger, "listenbrainz_done", `ListenBrainz: ${lbResult.accepted} accepted · ${lbResult.errors} errors`, lbResult.accepted > 0 ? "success" : "info");
  }

  // ── 7. Notifications + milestone detection ────────────────────────────────
  const repeatCount = timestamped.filter((p) => p.kind === "repeat").length;
  await notifySummary(
    env.NOTIFY_WEBHOOK_URL,
    lfmResult.accepted,
    repeatCount,
    lfmResult.ignored
  );

  const oldTotal = ledger.stats.total_scrobbled;
  const newTotal = oldTotal + lfmResult.accepted;
  if (Math.floor(oldTotal / 1000) < Math.floor(newTotal / 1000)) {
    const milestone = Math.floor(newTotal / 1000) * 1000;
    await notifyMilestone(env.NOTIFY_WEBHOOK_URL, milestone);
  }

  // ── 8. Record scrobbled track IDs in dedup list ───────────────────────────
  for (const p of timestamped) {
    const trackId = (p.track as any).id as string | undefined;
    if (trackId) recordScrobbled(ledger, trackId, startedAt);
  }

  // ── 9. Record recent scrobbles for the dashboard ──────────────────────────
  addRecentScrobbles(ledger, timestamped);

  // ── 10. Update ledger and persist ─────────────────────────────────────────
  ledger.previous_recent = current;
  ledger.stats.total_scrobbled = newTotal;
  ledger.stats.last_success_iso = runTime.toISOString();
  if (lfmResult.accepted > 0) {
    // Only clear error state on actual successful scrobbles
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
  }
  ledger.last_save_iso = runTime.toISOString();
  addLogEntry(
    ledger,
    "poll_complete",
    `Run done in ${Date.now() - startedAt}ms — ${lfmResult.accepted} scrobbled, ${newTotal} total. Saving KV.`,
    "success"
  );
  await saveLedger(env.ASCROBBLE_STATE, ledger);

  return {
    ok: true,
    detected: deduped.length,
    accepted: lfmResult.accepted,
    ignored: lfmResult.ignored,
    errors: lfmResult.errors,
    repeat_count: repeatCount,
    elapsed_ms: Date.now() - startedAt,
  };
}

export async function getStatus(env: Env): Promise<LedgerData> {
  return loadLedger(env.ASCROBBLE_STATE);
}

export async function resetLedgerStats(env: Env): Promise<LedgerData> {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  ledger.stats.total_errors = 0;
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = undefined;
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return ledger;
}

export async function updateTokens(
  env: Env,
  appleDevToken?: string,
  appleUserToken?: string
): Promise<{ ok: boolean; updated: string[] }> {
  const updated: string[] = [];
  if (appleDevToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN, appleDevToken);
    updated.push(KV_KEY_APPLE_DEV_TOKEN);
  }
  if (appleUserToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_USER_TOKEN, appleUserToken);
    updated.push(KV_KEY_APPLE_USER_TOKEN);
  }

  // Reset circuit breaker state upon token update
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  addLogEntry(ledger, "tokens_updated", `Updated KV tokens: ${updated.join(", ")}`, "success");
  await saveLedger(env.ASCROBBLE_STATE, ledger);

  return { ok: true, updated };
}

export interface ClearCacheOptions {
  clear_snapshot?: boolean;
  clear_dedup?: boolean;
  clear_logs?: boolean;
  clear_recent?: boolean;
  clear_circuit?: boolean;
}

export async function clearCache(
  env: Env,
  opts: ClearCacheOptions = {}
): Promise<{ ok: boolean; ledger: LedgerData }> {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);

  if (opts.clear_snapshot !== false) {
    ledger.previous_recent = [];
    ledger.stationary_idle = false;
    ledger.handled_count = 0;
    ledger.position0_elapsed_sec = 0;
    ledger.top_track_id = undefined;
    ledger.top_track_play_count = undefined;
  }

  if (opts.clear_dedup !== false) {
    ledger.recent_scrobble_ids = [];
  }

  if (opts.clear_logs) {
    ledger.log_entries = [];
  }

  if (opts.clear_recent) {
    ledger.recent_scrobbles = [];
  }

  if (opts.clear_circuit !== false) {
    resetCircuit(ledger);
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
  }

  addLogEntry(ledger, "cache_cleared", "Cleared worker state & cache via API", "info");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, ledger };
}

