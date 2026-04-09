// Typed fetch wrappers for the deployed worker's HTTP endpoints.
// Each takes the worker URL and status auth key as params.

import type { WorkerLedger } from "../types";

export async function fetchHealth(
  workerUrl: string
): Promise<{ ok: boolean; service: string; version: string }> {
  const resp = await fetch(`${workerUrl}/health`);
  if (!resp.ok) throw new Error(`Health check failed: HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchStatus(
  workerUrl: string,
  authKey: string
): Promise<WorkerLedger> {
  const resp = await fetch(`${workerUrl}/status?key=${encodeURIComponent(authKey)}`);
  if (resp.status === 401) throw new Error("Unauthorized: invalid STATUS_AUTH_KEY");
  if (!resp.ok) throw new Error(`Status fetch failed: HTTP ${resp.status}`);
  return resp.json();
}

export async function triggerScrobble(
  workerUrl: string,
  authKey: string
): Promise<{ ok: boolean; triggered: boolean }> {
  const resp = await fetch(`${workerUrl}/trigger?key=${encodeURIComponent(authKey)}`, {
    method: "POST",
  });
  if (resp.status === 401) throw new Error("Unauthorized: invalid STATUS_AUTH_KEY");
  if (!resp.ok) throw new Error(`Trigger failed: HTTP ${resp.status}`);
  return resp.json();
}
