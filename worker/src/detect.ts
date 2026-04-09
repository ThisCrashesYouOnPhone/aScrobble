/**
 * New + repeat play detection.
 *
 * Ported from v1/apple_scrobbler/detect.py (v0.2 fixed version).
 *
 * Apple's recently-played list is ordered most-recent-first. By diffing
 * the current list against the previous poll, we identify what was played.
 *
 * ALGORITHM (v0.2):
 *
 * Two strategies, in order:
 *
 * 1. POSITION-SHIFT (primary): when the user plays K new things, the
 *    recent-played list is the previous list with K new entries prepended:
 *      current = [new_K, ..., new_2, new_1, prev_0, prev_1, ...]
 *    Find the smallest K such that current[K:] equals previous[:len(current)-K].
 *    The first K entries of current are the new plays. This handles the
 *    case where Apple's API returns DUPLICATE entries for repeat plays
 *    of the same track (e.g. you played X three times in a row → list
 *    shows [X, X, X, ...]).
 *
 * 2. POSITION-TRACK fallback: when no valid K is found (Apple reorganized
 *    the list — moved a replayed track up to position 0 instead of adding
 *    a new entry), fall back to per-track position comparison.
 *
 * LIMITATION (still): if you replay a track that's already at position 0
 * AND Apple chooses to overwrite-in-place rather than add a new entry,
 * we get zero signal. The only fix is library playCount tracking, which
 * would 10× our API call volume. Future enhancement.
 */
import type { AppleTrack, DetectedPlay } from "./env";

export function detectPlays(
  current: AppleTrack[],
  previous: AppleTrack[]
): DetectedPlay[] {
  // First run: return everything in chronological order, all as "new"
  if (previous.length === 0) {
    return [...current].reverse().map((track) => ({ track, kind: "new" }));
  }

  // Strategy 1: position-shift detection
  const k = findShift(current, previous);
  if (k !== null) {
    const newPlays: DetectedPlay[] = [];
    for (let i = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" });
    }
    return newPlays.reverse(); // chronological, oldest first
  }

  // Strategy 2: position-tracking fallback
  return fallbackDetect(current, previous);
}

/**
 * Find the smallest K such that current[K:] equals previous[:len(current)-K]
 * (matched by track id). Returns null if no valid K exists.
 *
 * K must be < len(current) — we never return the trivial all-empty match.
 */
function findShift(
  current: AppleTrack[],
  previous: AppleTrack[]
): number | null {
  const curLen = current.length;
  const prevLen = previous.length;

  for (let k = 0; k < curLen; k++) {
    const suffixLen = curLen - k;
    // Suffix can't be longer than previous
    if (suffixLen > prevLen) continue;

    let match = true;
    for (let i = 0; i < suffixLen; i++) {
      if (current[k + i].id !== previous[i].id) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return null;
}

/**
 * Position-tracking fallback for when position-shift fails.
 *
 * Used when Apple has reorganized the list (e.g., moved a replayed track
 * up from a middle position to position 0) instead of adding a new entry.
 */
function fallbackDetect(
  current: AppleTrack[],
  previous: AppleTrack[]
): DetectedPlay[] {
  // Prefer the most recent (smallest index) entry per id when previous has dupes
  const prevIndex = new Map<string, number>();
  for (let i = 0; i < previous.length; i++) {
    if (!prevIndex.has(previous[i].id)) {
      prevIndex.set(previous[i].id, i);
    }
  }

  const detected: DetectedPlay[] = [];

  for (let newIdx = 0; newIdx < current.length; newIdx++) {
    const track = current[newIdx];
    const oldIdx = prevIndex.get(track.id);

    if (oldIdx === undefined) {
      detected.push({ track, kind: "new" });
      continue;
    }

    // How many genuinely new tracks sit above this one in the current list?
    let newAbove = 0;
    for (let i = 0; i < newIdx; i++) {
      if (!prevIndex.has(current[i].id)) newAbove++;
    }

    if (newIdx < oldIdx + newAbove) {
      detected.push({ track, kind: "repeat" });
    } else {
      // Hit the stable tail; everything below is unchanged
      break;
    }
  }

  return detected.reverse(); // chronological, oldest first
}
