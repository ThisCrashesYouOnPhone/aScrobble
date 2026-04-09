/**
 * Last.fm scrobble client.
 *
 * Ported from v1/apple_scrobbler/lastfm.py.
 *
 * Implements track.scrobble with the proper auth signing scheme:
 *   1. Take all params except 'format' and 'callback'
 *   2. Sort by key
 *   3. Concatenate as key1value1key2value2...
 *   4. Append shared secret
 *   5. MD5 the resulting UTF-8 string
 *   6. Add the hex digest as 'api_sig'
 *
 * Uses the pure-TypeScript MD5 from ./md5 instead of node:crypto so the
 * worker doesn't need the `nodejs_compat` compatibility flag. Smaller
 * bundle, fewer compat surfaces.
 *
 * Last.fm applies its own dedup based on (artist, track, timestamp) so
 * resubmissions of the same play are silently dropped, making retries safe.
 */
import { md5 } from "./md5";
import type { ScrobblePayload } from "./env";

const API_URL = "https://ws.audioscrobbler.com/2.0/";
const BATCH_SIZE = 50;

function signParams(
  params: Record<string, string>,
  sharedSecret: string
): string {
  const sigString =
    Object.keys(params)
      .filter((k) => k !== "format" && k !== "callback")
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("") + sharedSecret;
  return md5(sigString);
}

export interface LastfmResult {
  accepted: number;
  ignored: number;
  errors: number;
}

export async function scrobbleBatch(
  plays: ScrobblePayload[],
  apiKey: string,
  sharedSecret: string,
  sessionKey: string
): Promise<LastfmResult> {
  const result: LastfmResult = { accepted: 0, ignored: 0, errors: 0 };
  if (plays.length === 0) return result;

  for (let chunkStart = 0; chunkStart < plays.length; chunkStart += BATCH_SIZE) {
    const chunk = plays.slice(chunkStart, chunkStart + BATCH_SIZE);
    const params: Record<string, string> = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey,
    };

    chunk.forEach((play, i) => {
      if (!play.artist || !play.track) return;
      params[`artist[${i}]`] = play.artist;
      params[`track[${i}]`] = play.track;
      params[`timestamp[${i}]`] = Math.floor(
        play.timestamp.getTime() / 1000
      ).toString();
      if (play.album) params[`album[${i}]`] = play.album;
      if (play.duration_ms) {
        params[`duration[${i}]`] = Math.floor(play.duration_ms / 1000).toString();
      }
    });

    params.api_sig = signParams(params, sharedSecret);
    params.format = "json";

    const body = new URLSearchParams(params);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (e) {
      console.error("Last.fm HTTP error:", e);
      result.errors += chunk.length;
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`Last.fm ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
      continue;
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      console.error("Last.fm non-JSON response");
      result.errors += chunk.length;
      continue;
    }

    const attr = json?.scrobbles?.["@attr"] ?? {};
    result.accepted += parseInt(attr.accepted ?? "0", 10);
    result.ignored += parseInt(attr.ignored ?? "0", 10);

    // Log per-track reasons when Last.fm rejected something
    if (parseInt(attr.ignored ?? "0", 10) > 0) {
      let scrobbleList = json?.scrobbles?.scrobble ?? [];
      if (!Array.isArray(scrobbleList)) scrobbleList = [scrobbleList];
      for (const s of scrobbleList) {
        const msg = s?.ignoredMessage ?? {};
        if (msg.code && msg.code !== "0") {
          console.warn(
            `  ignored: ${s?.track?.["#text"] ?? "?"} — ${msg["#text"] ?? "?"} (code ${msg.code})`
          );
        }
      }
    }
  }

  return result;
}
