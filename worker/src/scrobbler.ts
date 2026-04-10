/**
 * Orchestrator: poll Apple → detect plays → assign timestamps → submit → persist.
 *
 * Ported from v1/apple_scrobbler/main.py. Called from both:
 *   - the scheduled() handler (cron firing every 5 min)
 *   - the /trigger endpoint (manual runs from the desktop app)
 *
 * Apple tokens are read from KV (not env) so the desktop app can rotate
 * them without redeploying the worker. See kv_keys.ts for the key names.
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
  type LedgerData,
} from "./ledger";
import { KV_KEY_APPLE_DEV_TOKEN, KV_KEY_APPLE_USER_TOKEN } from "./kv_keys";

export interface RunSummary {
  ok: boolean;
  detected: number;
  accepted: number;
  ignored: number;
  errors: number;
  repeat_count: number;
  elapsed_ms: number;
  error_message?: string;
}

export async function pollAndScrobble(env: Env): Promise<RunSummary> {
  const startedAt = Date.now();
  const runTime = new Date(startedAt);

  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  const lastRunTime = parseLastRunTime(ledger);

  ledger.stats.total_runs += 1;
  ledger.last_run_iso = runTime.toISOString();

  // Read Apple tokens from KV (rotatable without redeploying the worker)
  const [appleDevToken, appleUserToken] = await Promise.all([
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_USER_TOKEN),
  ]);

  if (!appleDevToken || !appleUserToken) {
    const msg = "apple_tokens_missing_in_kv";
    console.error(
      `${msg}: expected keys ${KV_KEY_APPLE_DEV_TOKEN} and ${KV_KEY_APPLE_USER_TOKEN}`
    );
    ledger.stats.total_errors += 1;
    ledger.stats.last_error_iso = runTime.toISOString();
    ledger.stats.last_error_message = msg;
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: false,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 1,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
      error_message: msg,
    };
  }

  // 1. Fetch Apple recently-played
  let current;
  try {
    current = await fetchRecentlyPlayed(appleDevToken, appleUserToken);
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      ledger.stats.total_errors += 1;
      ledger.stats.last_error_iso = runTime.toISOString();
      ledger.stats.last_error_message = "apple_token_expired";
      await saveLedger(env.ASCROBBLE_STATE, ledger);
      await notifyTokenExpired(env.NOTIFY_WEBHOOK_URL);
      return {
        ok: false,
        detected: 0,
        accepted: 0,
        ignored: 0,
        errors: 1,
        repeat_count: 0,
        elapsed_ms: Date.now() - startedAt,
        error_message: "apple_token_expired",
      };
    }
    throw e;
  }

  console.log(`Apple returned ${current.length} tracks`);

  // 2. Bootstrap protection: first run just snapshots, doesn't scrobble
  if (ledger.previous_recent.length === 0) {
    console.log(`First run — snapshotting ${current.length} tracks without scrobbling`);
    ledger.previous_recent = current;
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

  // 3. Detect what's new since last poll
  const plays = detectPlays(current, ledger.previous_recent);

  // 3a. Position-0 silent repeat probe.
  //
  // When position-shift returns k=0 (no new entries detected) AND the same
  // track is still at position 0, Apple may have overwritten the list entry
  // in-place instead of prepending a new one. We fire one extra API call to
  // compare the library play count. If it increased, emit repeat plays.
  //
  // Cost: ≤ 1 extra call/poll, and only when the top track hasn't changed.
  // ISRC is required — tracks without it (rare) silently skip the probe.
  console.log(`Position-0 probe check: plays=${plays.length}, current.length=${current.length}, previous.length=${ledger.previous_recent.length}`);
  if (plays.length === 0 && current.length > 0 && ledger.previous_recent.length > 0) {
    const topTrack = current[0];
    const prevTopTrack = ledger.previous_recent[0];
    console.log(`Position-0 probe: topTrack.id=${topTrack.id}, prevTopTrack.id=${prevTopTrack.id}, isrc=${topTrack.isrc}`);

    if (topTrack.id === prevTopTrack.id && topTrack.isrc) {
      console.log(`Position-0 probe: Fetching play count for ISRC ${topTrack.isrc}`);
      const newCount = await fetchTrackPlayCount(appleDevToken, appleUserToken, topTrack.isrc);
      console.log(`Position-0 probe: newCount=${newCount}, stored top_track_id=${ledger.top_track_id}, stored play_count=${ledger.top_track_play_count}`);
      if (newCount !== null) {
        const prevCount = ledger.top_track_id === topTrack.id ? ledger.top_track_play_count : undefined;
        console.log(`Position-0 probe: prevCount=${prevCount}`);
        if (prevCount !== undefined && newCount > prevCount) {
          const delta = newCount - prevCount;
          console.log(
            `Position-0 probe: play count for "${topTrack.name}" rose by ${delta} — emitting ${delta} silent repeat(s)`
          );
          for (let i = 0; i < delta; i++) {
            plays.push({ track: topTrack, kind: "repeat" });
          }
        } else if (prevCount === undefined) {
          console.log(`Position-0 probe: First observation for this track, count=${newCount}, no repeats yet`);
        } else if (newCount <= prevCount) {
          console.log(`Position-0 probe: Count did not increase (${prevCount} -> ${newCount})`);
        }
        ledger.top_track_id = topTrack.id;
        ledger.top_track_play_count = newCount;
      } else {
        console.log(`Position-0 probe: fetchTrackPlayCount returned null - ISRC may not be in user's library`);
      }
    } else {
      console.log(`Position-0 probe: SKIPPED - sameTrack=${topTrack.id === prevTopTrack.id}, hasISRC=${!!topTrack.isrc}`);
      // Top track changed — reset probe state for the new track
      ledger.top_track_id = current[0]?.id;
      ledger.top_track_play_count = undefined;
    }
  } else {
    console.log(`Position-0 probe: SKIPPED - condition not met`);
  }

  if (plays.length === 0) {
    console.log("No new plays");
    ledger.previous_recent = current;
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

  console.log(`Detected ${plays.length} plays`);

  // 4. Assign timestamps
  const timestamped = assignTimestamps(plays, runTime, lastRunTime);

  for (const p of timestamped) {
    console.log(
      `  [${p.kind}] ${p.track.artist} — ${p.track.name} @ ${p.timestamp?.toISOString()}`
    );
  }

  // 5. Build canonical payload and submit to Last.fm (canonical target)
  const payload: ScrobblePayload[] = timestamped.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp: p.timestamp!,
    duration_ms: p.track.duration_ms,
  }));

  let lfmResult = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );

  // Retry once on a full-batch network failure. Last.fm deduplicates by
  // (artist, track, timestamp), so a double-submit is silently dropped.
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    console.warn(`Last.fm: all ${lfmResult.errors} tracks failed — retrying after 1 s`);
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

  // 6. Optional: also submit to ListenBrainz
  if (env.LISTENBRAINZ_TOKEN) {
    const lbResult = await submitToListenBrainz(payload, env.LISTENBRAINZ_TOKEN);
    console.log(
      `ListenBrainz: ${lbResult.accepted} accepted, ${lbResult.errors} errors`
    );
  }

  // 7. Notifications + milestone detection
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

  // 8. Record recent scrobbles for the dashboard
  addRecentScrobbles(ledger, timestamped);

  // 9. Update ledger and persist
  ledger.previous_recent = current;
  ledger.stats.total_scrobbled = newTotal;
  ledger.stats.last_success_iso = runTime.toISOString();
  await saveLedger(env.ASCROBBLE_STATE, ledger);

  return {
    ok: true,
    detected: plays.length,
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
