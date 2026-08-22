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

export interface DetectionState {
  stationaryIdle?: boolean;
  handledCount?: number;
  position0ElapsedSec?: number;
}

export interface DetectionResult {
  plays: DetectedPlay[];
  newState: DetectionState;
}

export function detectPlays(
  current: AppleTrack[],
  previous: AppleTrack[],
  _elapsedSeconds: number = 180,
  prevState: DetectionState = {}
): DetectionResult {
  // First run: return everything in chronological order, all as "new"
  if (previous.length === 0) {
    const plays = [...current].reverse().map((track) => ({ track, kind: "new" as const }));
    return {
      plays,
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }

  // Strategy 1: Position-Shift matching (K > 0)
  const k = findShift(current, previous);
  if (k !== null && k > 0) {
    const newPlays: DetectedPlay[] = [];
    for (let i = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" as const });
    }
    return {
      plays: newPlays.reverse(),
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }

  // Strategy 2: Top-Rebound & Tail-Shift Recovery (inspired by multi-scrobbler)
  if (current.length >= 2 && previous.length >= 2 && current[0].id === previous[0].id) {
    const curTail = current.slice(1);
    const prevTail = previous.slice(1);
    const tailShift = findShift(curTail, prevTail);

    if (tailShift !== null && tailShift > 0) {
      const interimPlays: DetectedPlay[] = [];
      for (let i = 0; i < tailShift; i++) {
        interimPlays.push({ track: curTail[i], kind: "top-rebound" as const });
      }
      interimPlays.push({ track: current[0], kind: "top-rebound" as const });
      return {
        plays: interimPlays.reverse(),
        newState: { stationaryIdle: false, handledCount: (prevState.handledCount ?? 1) + 1, position0ElapsedSec: 0 }
      };
    }
  }

  // Strategy 3: Stationary Position 0 Guard
  // When track 0 and the tail have not moved (user is listening mid-song or paused),
  // return 0 plays. This prevents false double scrobbles when the user listens once and pauses.
  if (current.length > 0 && previous.length > 0 && current[0].id === previous[0].id) {
    return {
      plays: [],
      newState: {
        stationaryIdle: true,
        handledCount: prevState.handledCount ?? 1,
        position0ElapsedSec: 0,
      }
    };
  }

  // Strategy 4: Fallback Position Tracking
  const fallback = fallbackDetect(current, previous);
  return {
    plays: fallback,
    newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
  };
}

/**
 * Find the smallest K such that current[K:] equals previous[:len(current)-K]
 */
function findShift(
  current: AppleTrack[],
  previous: AppleTrack[]
): number | null {
  const curLen = current.length;
  const prevLen = previous.length;

  for (let k = 0; k < curLen; k++) {
    const suffixLen = curLen - k;
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
 */
function fallbackDetect(
  current: AppleTrack[],
  previous: AppleTrack[]
): DetectedPlay[] {
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

    let newAbove = 0;
    for (let i = 0; i < newIdx; i++) {
      if (!prevIndex.has(current[i].id)) newAbove++;
    }

    if (newIdx < oldIdx + newAbove) {
      detected.push({ track, kind: "repeat" });
    } else {
      break;
    }
  }

  return detected.reverse();
}
