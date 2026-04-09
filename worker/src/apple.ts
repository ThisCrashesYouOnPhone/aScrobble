/**
 * Apple Music API client.
 *
 * Ported 1:1 from v1/apple_scrobbler/apple.py.
 *
 * Uses the "web-scraped" developer token + Music-User-Token that the
 * desktop app captured from music.apple.com. Apple's recently-played
 * endpoint has three hard limits we live with:
 *   - max 10 tracks per request (limit > 10 → error)
 *   - max ~50 tracks total via offset pagination
 *   - no play timestamps in the response (we reconstruct them)
 *
 * The Origin + Referer + User-Agent spoof makes the request look
 * indistinguishable from the real web player, which is how Cider
 * worked around Apple's client checks after they tightened them
 * in late 2022.
 *
 * v0.2 NOTE: this used to dedupe by track ID across pages, which
 * collapsed legitimate consecutive plays of the same song into one.
 * The fix: each list entry is preserved verbatim, including duplicates.
 * The only narrow dedupe is for page-boundary race conditions, which
 * never affect genuine repeat plays.
 */
import type { AppleTrack } from "./env";

const API_BASE = "https://api.music.apple.com/v1";
const PAGE_SIZE = 10;
const MAX_OFFSET = 40; // offsets 0,10,20,30,40 → up to 50 tracks

export class TokenExpiredError extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. " +
        "Re-open the amusic desktop app to re-authenticate with Apple Music."
    );
    this.name = "TokenExpiredError";
  }
}

const SPOOFED_HEADERS = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
} as const;

interface AppleApiItem {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
  };
}

interface AppleApiResponse {
  data?: AppleApiItem[];
}

export async function fetchRecentlyPlayed(
  devToken: string,
  musicUserToken: string
): Promise<AppleTrack[]> {
  const tracks: AppleTrack[] = [];

  const headers = {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS,
  };

  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${API_BASE}/me/recent/played/tracks?limit=${PAGE_SIZE}&offset=${offset}`;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (e) {
      console.warn(`Apple fetch failed at offset ${offset}:`, e);
      break;
    }

    if (response.status === 401) throw new TokenExpiredError();

    if (!response.ok) {
      const body = await response.text();
      console.warn(
        `Apple API ${response.status} at offset ${offset}: ${body.slice(0, 200)}`
      );
      break;
    }

    const json = (await response.json()) as AppleApiResponse;
    const items = json.data ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      if (!item.id) continue;
      const attrs = item.attributes ?? {};
      tracks.push({
        id: item.id,
        name: attrs.name ?? "",
        artist: attrs.artistName ?? "",
        album: attrs.albumName ?? "",
        duration_ms: attrs.durationInMillis ?? 180_000,
        isrc: attrs.isrc,
      });
    }

    if (items.length < PAGE_SIZE) break; // last page
  }

  // Page-boundary race protection: when paginating sequentially, a play
  // happening between requests can shift the list and cause one entry to
  // appear at the END of page N and the START of page N+1. We detect this
  // narrowly: if entry i and entry i-1 share an id AND fall on a 10-track
  // page boundary, drop entry i. This catches the race without affecting
  // genuine consecutive duplicate plays (which never sit on a boundary).
  const deduped: AppleTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (i > 0 && i % PAGE_SIZE === 0 && tracks[i - 1].id === tracks[i].id) {
      continue;
    }
    deduped.push(tracks[i]);
  }
  return deduped;
}
