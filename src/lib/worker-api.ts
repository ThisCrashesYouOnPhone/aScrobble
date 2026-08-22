// Typed fetch wrappers for the deployed worker's HTTP endpoints.
// Each takes the worker URL and status auth key as params.

import type { WorkerLedger } from "../types";
import { getWorkerStatus, resetWorkerStatsBackend } from "./tauri";

export async function fetchHealth(
  workerUrl: string
): Promise<{ ok: boolean; service: string; version: string }> {
  try {
    const resp = await fetch(`${workerUrl}/health`);
    if (!resp.ok) throw new Error(`Health check failed: HTTP ${resp.status}`);
    return resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to reach worker at ${workerUrl}: ${msg}`);
  }
}

export async function fetchStatus(
  _workerUrl: string,
  _authKey: string
): Promise<WorkerLedger> {
  // Call backend command instead of fetching directly - avoids CORS issues
  try {
    console.log("Fetching worker status from backend command");
    const ledger = await getWorkerStatus();
    console.log("Successfully got worker status from backend:", ledger);
    return ledger;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("get_worker_status error:", msg);
    throw new Error(
      `Worker is unreachable. Backend error: ${msg}. Try redeploying the worker.`
    );
  }
}

export async function triggerScrobble(
  workerUrl: string,
  authKey: string
): Promise<{ ok: boolean; triggered: boolean; ledger?: WorkerLedger }> {
  try {
    const resp = await fetch(`${workerUrl}/trigger?key=${encodeURIComponent(authKey)}&_t=${Date.now()}`, {
      method: "POST",
      headers: { "Cache-Control": "no-cache" },
    });
    if (resp.status === 401) {
      throw new Error(
        "Unauthorized: invalid STATUS_AUTH_KEY. The worker may not be fully deployed. Try redeploying."
      );
    }
    if (!resp.ok) {
      throw new Error(`Trigger failed: HTTP ${resp.status}`);
    }
    return resp.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Failed to fetch")) {
      throw new Error(
        `Failed to trigger scrobble: worker is unreachable at ${workerUrl}`
      );
    }
    throw e;
  }
}

export async function resetWorkerStats(
  workerUrl: string,
  authKey: string
): Promise<WorkerLedger> {
  try {
    const ledger = await resetWorkerStatsBackend();
    return ledger;
  } catch (e) {
    const resp = await fetch(`${workerUrl}/reset-stats?key=${encodeURIComponent(authKey)}`, {
      method: "POST",
    });
    if (!resp.ok) throw new Error(`Reset stats failed: HTTP ${resp.status}`);
    return resp.json();
  }
}

export async function fetchLastfmAlbumArt(
  apiKey: string,
  artist: string,
  album: string
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      method: "album.getinfo",
      artist: artist,
      album: album,
      api_key: apiKey,
      format: "json",
    });
    
    const resp = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    if (!resp.ok) return null;
    
    const data = await resp.json();
    if (!data.album?.image) return null;
    
    // Find the largest image available
    const images = data.album.image as Array<{ size: string; "#text": string }>;
    const largeImage = images.find((img) => img.size === "large" || img.size === "extralarge");
    return largeImage?.["#text"] || images[images.length - 1]?.["#text"] || null;
  } catch (e) {
    // Silently fail - not critical if album art is missing
    return null;
  }
}
