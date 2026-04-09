/**
 * Heuristic timestamp reconstruction.
 *
 * Ported 1:1 from v1/apple_scrobbler/timestamps.py.
 *
 * Apple's recently-played endpoint gives us NO play timestamps. We walk
 * BACKWARD from the current poll time, subtracting each track's duration
 * in turn. This produces a Last.fm timeline where tracks are naturally
 * spaced by their lengths instead of clustered at the cron tick second.
 *
 * Error bound: at most one polling interval. At 5-min polling, plays are
 * reconstructed within ±5 minutes of the true time.
 */
import type { DetectedPlay } from "./env";

const DEFAULT_DURATION_MS = 180_000; // 3 min fallback when Apple omits duration
const HEAD_OFFSET_SECONDS = 10; // small gap so the newest play isn't stamped exactly at :00

export function assignTimestamps(
  plays: DetectedPlay[],
  runTime: Date,
  lastRunTime: Date | null
): DetectedPlay[] {
  if (plays.length === 0) return plays;

  // On the very first run, reach back 6 hours as a reasonable window.
  const floor =
    lastRunTime ?? new Date(runTime.getTime() - 6 * 60 * 60 * 1000);

  const windowSeconds = Math.max(
    1,
    (runTime.getTime() - floor.getTime()) / 1000 - HEAD_OFFSET_SECONDS
  );
  const totalDurationSeconds = plays.reduce(
    (sum, p) => sum + (p.track.duration_ms || DEFAULT_DURATION_MS) / 1000,
    0
  );

  // If the sum of durations exceeds the poll window (user played a lot
  // and skipped things), compress proportionally so timestamps still fit.
  const scale =
    totalDurationSeconds > windowSeconds
      ? windowSeconds / totalDurationSeconds
      : 1.0;

  // Walk newest → oldest, accumulating offset from runTime
  let cumulative = HEAD_OFFSET_SECONDS;
  const reversed: DetectedPlay[] = [];

  for (let i = plays.length - 1; i >= 0; i--) {
    const play = plays[i];
    const durationSeconds =
      ((play.track.duration_ms || DEFAULT_DURATION_MS) / 1000) * scale;
    const timestamp = new Date(
      runTime.getTime() - (cumulative + durationSeconds) * 1000
    );
    cumulative += durationSeconds;
    reversed.push({ ...play, timestamp });
  }

  // Restore chronological order (oldest first)
  return reversed.reverse();
}
