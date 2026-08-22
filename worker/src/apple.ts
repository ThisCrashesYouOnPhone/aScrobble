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
const PAGE_SIZE = 30;
const MAX_OFFSET = 90; // up to 120 tracks total (0, 30, 60, 90)

export class TokenExpiredError extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. " +
        "Re-open the aScrobble desktop app to re-authenticate with Apple Music."
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
    albumArtistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
  };
}

interface AppleApiResponse {
  data?: AppleApiItem[];
}

/** Normalize album name by stripping trailing ' - EP' or ' - Single' suffixes. */
function normalizeAlbumName(rawAlbum: string): string {
  if (!rawAlbum) return "";
  return rawAlbum.replace(/ - (EP|Single)$/i, "").trim();
}

/**
 * Probe the play count for a single track by ISRC via the library songs endpoint.
 */
export async function fetchTrackPlayCount(
  devToken: string,
  musicUserToken: string,
  isrc: string
): Promise<number | null> {
  const url = `${API_BASE}/me/library/songs?filter[isrc]=${encodeURIComponent(isrc)}&fields[library-songs]=playCount&limit=1`;
  const headers = {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS,
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: Array<{ attributes?: { playCount?: number } }> };
    const count = json.data?.[0]?.attributes?.playCount;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
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
      const rawAlbum = attrs.albumName ?? "";
      tracks.push({
        id: item.id,
        name: attrs.name ?? "",
        artist: attrs.artistName ?? "",
        album_artist: attrs.albumArtistName ?? attrs.artistName ?? "",
        album: normalizeAlbumName(rawAlbum),
        duration_ms: attrs.durationInMillis ?? 180_000,
        isrc: attrs.isrc,
      });
    }

    if (items.length < PAGE_SIZE) break; // single page (up to 30 items)
  }

  const deduped: AppleTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (i > 0 && i % PAGE_SIZE === 0 && tracks[i - 1].id === tracks[i].id) {
      continue;
    }
    deduped.push(tracks[i]);
  }
  return deduped;
}
