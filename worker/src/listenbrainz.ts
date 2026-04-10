/**
 * ListenBrainz client.
 *
 * Ported from v1/apple_scrobbler/listenbrainz.py.
 *
 * ListenBrainz is the open MusicBrainz-affiliated alternative to Last.fm.
 * This client is OPTIONAL — if LISTENBRAINZ_TOKEN isn't set, scrobbler.ts
 * skips ListenBrainz entirely.
 *
 * Value: redundant copy of the user's listening history on a free,
 * non-profit, full-export-anytime service. Hedge against Last.fm ever
 * changing hands or breaking.
 *
 * Server-side dedup is based on (user, listened_at, recording), same
 * safety property as Last.fm — resubmissions are silently dropped.
 */
import type { ScrobblePayload } from "./env";

const API_URL = "https://api.listenbrainz.org/1/submit-listens";
const BATCH_SIZE = 100; // LB allows ~1000, but 100 is plenty for CPU budget

export interface ListenBrainzResult {
  accepted: number;
  errors: number;
}

export async function submitBatch(
  plays: ScrobblePayload[],
  userToken: string
): Promise<ListenBrainzResult> {
  const result: ListenBrainzResult = { accepted: 0, errors: 0 };
  if (plays.length === 0) return result;

  const entries = plays
    .filter((p) => p.artist && p.track)
    .map((p) => ({
      listened_at: Math.floor(p.timestamp.getTime() / 1000),
      track_metadata: {
        artist_name: p.artist,
        track_name: p.track,
        release_name: p.album || undefined,
        additional_info: {
          submission_client: "aScrobble-scrobbler",
          submission_client_version: "0.2.0",
          music_service: "music.apple.com",
          duration_ms: p.duration_ms || undefined,
        },
      },
    }));

  for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BATCH_SIZE) {
    const chunk = entries.slice(chunkStart, chunkStart + BATCH_SIZE);
    const body = {
      listen_type: chunk.length === 1 ? "single" : "import",
      payload: chunk,
    };

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Token ${userToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error("ListenBrainz HTTP error:", e);
      result.errors += chunk.length;
      continue;
    }

    if (response.ok) {
      result.accepted += chunk.length;
    } else if (response.status === 401) {
      console.error(
        "ListenBrainz 401 — LISTENBRAINZ_TOKEN invalid. Get a new one at " +
          "https://listenbrainz.org/profile/"
      );
      result.errors += chunk.length;
      break; // no point continuing if auth is broken
    } else {
      const text = await response.text();
      console.error(`ListenBrainz ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
    }
  }

  return result;
}
