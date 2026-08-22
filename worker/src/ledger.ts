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
  kind: "new" | "repeat" | "top-rebound" | "time-elapsed-repeat";
}

export interface LogEntry {
  timestamp_iso: string;
  step: string;
  details?: string;
  level?: "info" | "warn" | "error" | "success";
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
  log_entries?: LogEntry[];
  top_track_id?: string;
  top_track_play_count?: number;
  stationary_idle?: boolean;
  handled_count?: number;
  last_save_iso?: string;
  consecutive_errors?: number;
  circuit_open_until_iso?: string;
  position0_elapsed_sec?: number;
  recent_scrobble_ids?: string[];
}

export function addLogEntry(
  ledger: LedgerData,
  step: string,
  details?: string,
  level: "info" | "warn" | "error" | "success" = "info"
): void {
  if (!ledger.log_entries) ledger.log_entries = [];
  ledger.log_entries.unshift({
    timestamp_iso: new Date().toISOString(),
    step,
    details,
    level,
  });
  // Keep last 50 verbose log entries
  ledger.log_entries = ledger.log_entries.slice(0, 50);
}

const MAX_RECENT_SCROBBLES = 1000;

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

let MEMORY_LEDGER_CACHE: LedgerData | null = null;

export async function loadLedger(kv: KVNamespace): Promise<LedgerData> {
  try {
    const raw = await kv.get(LEDGER_KEY, "json");
    if (raw && typeof raw === "object") {
      const kvLedger = { ...DEFAULT_LEDGER, ...(raw as Partial<LedgerData>) };
      if (MEMORY_LEDGER_CACHE && MEMORY_LEDGER_CACHE.last_run_iso) {
        const memoryTime = new Date(MEMORY_LEDGER_CACHE.last_run_iso).getTime();
        const kvTime = kvLedger.last_run_iso ? new Date(kvLedger.last_run_iso).getTime() : 0;
        if (memoryTime >= kvTime) {
          return MEMORY_LEDGER_CACHE;
        }
      }
      MEMORY_LEDGER_CACHE = kvLedger;
      return kvLedger;
    }
  } catch (e) {
    console.warn("Ledger read failed, starting fresh:", e);
  }
  return MEMORY_LEDGER_CACHE ?? { ...DEFAULT_LEDGER };
}

export async function saveLedger(
  kv: KVNamespace,
  ledger: LedgerData
): Promise<void> {
  MEMORY_LEDGER_CACHE = ledger;
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
}

export function addRecentScrobbles(
  ledger: LedgerData,
  plays: Array<{ track: { artist: string; name: string; album: string }; kind: "new" | "repeat" | "top-rebound" | "time-elapsed-repeat"; timestamp?: Date }>
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
