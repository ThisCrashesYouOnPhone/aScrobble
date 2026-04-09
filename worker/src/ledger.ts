/**
 * KV-backed ledger state.
 *
 * Replaces v1/apple_scrobbler/ledger.py's JSON-file approach with a
 * single KV key holding the same shape. KV writes are ~288/day at
 * 5-min polling, well under the free tier's 1000 writes/day limit.
 *
 * All state lives under one key so we can do atomic read-modify-write
 * without juggling multiple KV operations.
 */
import type { AppleTrack } from "./env";

const LEDGER_KEY = "ledger:v1";

export interface RecentScrobble {
  artist: string;
  track: string;
  album: string;
  timestamp_iso: string;
  kind: "new" | "repeat";
}

export interface LedgerData {
  version: 1;
  last_run_iso: string | null;
  previous_recent: AppleTrack[];
  recent_scrobbles: RecentScrobble[];
  stats: {
    total_scrobbled: number;
    total_runs: number;
    total_errors: number;
    last_success_iso: string | null;
    last_error_iso: string | null;
    last_error_message: string | null;
  };
}

const MAX_RECENT_SCROBBLES = 100;

const DEFAULT_LEDGER: LedgerData = {
  version: 1,
  last_run_iso: null,
  previous_recent: [],
  recent_scrobbles: [],
  stats: {
    total_scrobbled: 0,
    total_runs: 0,
    total_errors: 0,
    last_success_iso: null,
    last_error_iso: null,
    last_error_message: null,
  },
};

export async function loadLedger(kv: KVNamespace): Promise<LedgerData> {
  try {
    const raw = await kv.get(LEDGER_KEY, "json");
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_LEDGER, ...(raw as Partial<LedgerData>) };
    }
  } catch (e) {
    console.warn("Ledger read failed, starting fresh:", e);
  }
  return { ...DEFAULT_LEDGER };
}

export async function saveLedger(
  kv: KVNamespace,
  ledger: LedgerData
): Promise<void> {
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
}

export function addRecentScrobbles(
  ledger: LedgerData,
  plays: Array<{ track: { artist: string; name: string; album: string }; kind: "new" | "repeat"; timestamp?: Date }>
): void {
  const newEntries: RecentScrobble[] = plays.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp_iso: p.timestamp?.toISOString() ?? new Date().toISOString(),
    kind: p.kind,
  }));
  ledger.recent_scrobbles = [...newEntries, ...ledger.recent_scrobbles].slice(
    0,
    MAX_RECENT_SCROBBLES
  );
}

export function parseLastRunTime(ledger: LedgerData): Date | null {
  if (!ledger.last_run_iso) return null;
  const d = new Date(ledger.last_run_iso);
  return isNaN(d.getTime()) ? null : d;
}
