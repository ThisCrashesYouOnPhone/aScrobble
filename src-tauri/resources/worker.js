// src/apple.ts
var API_BASE = "https://api.music.apple.com/v1";
var PAGE_SIZE = 10;
var MAX_OFFSET = 40;
var TokenExpiredError = class extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. Re-open the amusic desktop app to re-authenticate with Apple Music."
    );
    this.name = "TokenExpiredError";
  }
};
var SPOOFED_HEADERS = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
};
async function fetchRecentlyPlayed(devToken, musicUserToken) {
  const tracks = [];
  const headers = {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS
  };
  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
    const url = `${API_BASE}/me/recent/played/tracks?limit=${PAGE_SIZE}&offset=${offset}`;
    let response;
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
    const json2 = await response.json();
    const items = json2.data ?? [];
    if (items.length === 0) break;
    for (const item of items) {
      if (!item.id) continue;
      const attrs = item.attributes ?? {};
      tracks.push({
        id: item.id,
        name: attrs.name ?? "",
        artist: attrs.artistName ?? "",
        album: attrs.albumName ?? "",
        duration_ms: attrs.durationInMillis ?? 18e4,
        isrc: attrs.isrc
      });
    }
    if (items.length < PAGE_SIZE) break;
  }
  const deduped = [];
  for (let i = 0; i < tracks.length; i++) {
    if (i > 0 && i % PAGE_SIZE === 0 && tracks[i - 1].id === tracks[i].id) {
      continue;
    }
    deduped.push(tracks[i]);
  }
  return deduped;
}

// src/detect.ts
function detectPlays(current, previous) {
  if (previous.length === 0) {
    return [...current].reverse().map((track) => ({ track, kind: "new" }));
  }
  const k = findShift(current, previous);
  if (k !== null) {
    const newPlays = [];
    for (let i = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" });
    }
    return newPlays.reverse();
  }
  return fallbackDetect(current, previous);
}
function findShift(current, previous) {
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
function fallbackDetect(current, previous) {
  const prevIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < previous.length; i++) {
    if (!prevIndex.has(previous[i].id)) {
      prevIndex.set(previous[i].id, i);
    }
  }
  const detected = [];
  for (let newIdx = 0; newIdx < current.length; newIdx++) {
    const track = current[newIdx];
    const oldIdx = prevIndex.get(track.id);
    if (oldIdx === void 0) {
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

// src/timestamps.ts
var DEFAULT_DURATION_MS = 18e4;
var HEAD_OFFSET_SECONDS = 10;
function assignTimestamps(plays, runTime, lastRunTime) {
  if (plays.length === 0) return plays;
  const floor = lastRunTime ?? new Date(runTime.getTime() - 6 * 60 * 60 * 1e3);
  const windowSeconds = Math.max(
    1,
    (runTime.getTime() - floor.getTime()) / 1e3 - HEAD_OFFSET_SECONDS
  );
  const totalDurationSeconds = plays.reduce(
    (sum, p) => sum + (p.track.duration_ms || DEFAULT_DURATION_MS) / 1e3,
    0
  );
  const scale = totalDurationSeconds > windowSeconds ? windowSeconds / totalDurationSeconds : 1;
  let cumulative = HEAD_OFFSET_SECONDS;
  const reversed = [];
  for (let i = plays.length - 1; i >= 0; i--) {
    const play = plays[i];
    const durationSeconds = (play.track.duration_ms || DEFAULT_DURATION_MS) / 1e3 * scale;
    const timestamp = new Date(
      runTime.getTime() - (cumulative + durationSeconds) * 1e3
    );
    cumulative += durationSeconds;
    reversed.push({ ...play, timestamp });
  }
  return reversed.reverse();
}

// src/md5.ts
function cmn(q, a, b, x, s, t) {
  a = (a + q | 0) + (x + t | 0) | 0;
  return (a << s | a >>> 32 - s) + b | 0;
}
function ff(a, b, c, d, x, s, t) {
  return cmn(b & c | ~b & d, a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn(b & d | c & ~d, a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);
  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);
  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);
  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);
  x[0] = x[0] + a | 0;
  x[1] = x[1] + b | 0;
  x[2] = x[2] + c | 0;
  x[3] = x[3] + d | 0;
}
function md51(bytes) {
  const n = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  const tail = new Array(16);
  for (i = 64; i <= n; i += 64) {
    md5blk(bytes, i - 64, tail);
    md5cycle(state, tail);
  }
  const bufLen = n - (i - 64);
  for (let j = 0; j < 16; j++) tail[j] = 0;
  for (let j = 0; j < bufLen; j++) {
    tail[j >> 2] |= bytes[i - 64 + j] << (j % 4 << 3);
  }
  tail[bufLen >> 2] |= 128 << (bufLen % 4 << 3);
  if (bufLen > 55) {
    md5cycle(state, tail);
    for (let j = 0; j < 16; j++) tail[j] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
function md5blk(bytes, offset, out) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    out[i] = bytes[j] | bytes[j + 1] << 8 | bytes[j + 2] << 16 | bytes[j + 3] << 24;
  }
}
function rhex(n) {
  const hex = "0123456789abcdef";
  let s = "";
  for (let j = 0; j < 4; j++) {
    s += hex[n >> j * 8 + 4 & 15] + hex[n >> j * 8 & 15];
  }
  return s;
}
function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const state = md51(bytes);
  return state.map(rhex).join("");
}

// src/lastfm.ts
var API_URL = "https://ws.audioscrobbler.com/2.0/";
var BATCH_SIZE = 50;
function signParams(params, sharedSecret) {
  const sigString = Object.keys(params).filter((k) => k !== "format" && k !== "callback").sort().map((k) => `${k}${params[k]}`).join("") + sharedSecret;
  return md5(sigString);
}
async function scrobbleBatch(plays, apiKey, sharedSecret, sessionKey) {
  const result = { accepted: 0, ignored: 0, errors: 0 };
  if (plays.length === 0) return result;
  for (let chunkStart = 0; chunkStart < plays.length; chunkStart += BATCH_SIZE) {
    const chunk = plays.slice(chunkStart, chunkStart + BATCH_SIZE);
    const params = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey
    };
    chunk.forEach((play, i) => {
      if (!play.artist || !play.track) return;
      params[`artist[${i}]`] = play.artist;
      params[`track[${i}]`] = play.track;
      params[`timestamp[${i}]`] = Math.floor(
        play.timestamp.getTime() / 1e3
      ).toString();
      if (play.album) params[`album[${i}]`] = play.album;
      if (play.duration_ms) {
        params[`duration[${i}]`] = Math.floor(play.duration_ms / 1e3).toString();
      }
    });
    params.api_sig = signParams(params, sharedSecret);
    params.format = "json";
    const body = new URLSearchParams(params);
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
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
    let json2;
    try {
      json2 = await response.json();
    } catch {
      console.error("Last.fm non-JSON response");
      result.errors += chunk.length;
      continue;
    }
    const attr = json2?.scrobbles?.["@attr"] ?? {};
    result.accepted += parseInt(attr.accepted ?? "0", 10);
    result.ignored += parseInt(attr.ignored ?? "0", 10);
    if (parseInt(attr.ignored ?? "0", 10) > 0) {
      let scrobbleList = json2?.scrobbles?.scrobble ?? [];
      if (!Array.isArray(scrobbleList)) scrobbleList = [scrobbleList];
      for (const s of scrobbleList) {
        const msg = s?.ignoredMessage ?? {};
        if (msg.code && msg.code !== "0") {
          console.warn(
            `  ignored: ${s?.track?.["#text"] ?? "?"} \u2014 ${msg["#text"] ?? "?"} (code ${msg.code})`
          );
        }
      }
    }
  }
  return result;
}

// src/listenbrainz.ts
var API_URL2 = "https://api.listenbrainz.org/1/submit-listens";
var BATCH_SIZE2 = 100;
async function submitBatch(plays, userToken) {
  const result = { accepted: 0, errors: 0 };
  if (plays.length === 0) return result;
  const entries = plays.filter((p) => p.artist && p.track).map((p) => ({
    listened_at: Math.floor(p.timestamp.getTime() / 1e3),
    track_metadata: {
      artist_name: p.artist,
      track_name: p.track,
      release_name: p.album || void 0,
      additional_info: {
        submission_client: "amusic-scrobbler",
        submission_client_version: "0.2.0",
        music_service: "music.apple.com",
        duration_ms: p.duration_ms || void 0
      }
    }
  }));
  for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BATCH_SIZE2) {
    const chunk = entries.slice(chunkStart, chunkStart + BATCH_SIZE2);
    const body = {
      listen_type: chunk.length === 1 ? "single" : "import",
      payload: chunk
    };
    let response;
    try {
      response = await fetch(API_URL2, {
        method: "POST",
        headers: {
          Authorization: `Token ${userToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
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
        "ListenBrainz 401 \u2014 LISTENBRAINZ_TOKEN invalid. Get a new one at https://listenbrainz.org/profile/"
      );
      result.errors += chunk.length;
      break;
    } else {
      const text = await response.text();
      console.error(`ListenBrainz ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
    }
  }
  return result;
}

// src/notify.ts
async function notifyTokenExpired(webhookUrl) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    "\u{1F534} **amusic**: Apple Music tokens expired (401).\nRe-open the amusic desktop app to re-authenticate with Apple Music."
  );
}
async function notifyMilestone(webhookUrl, total) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    `\u{1F3B5} **amusic**: hit **${total.toLocaleString()}** total scrobbles`
  );
}
async function notifySummary(webhookUrl, accepted, repeatCount, ignored) {
  if (!webhookUrl || accepted === 0) return;
  const parts = [`**${accepted}** scrobbled`];
  if (repeatCount > 0) parts.push(`${repeatCount} repeat plays`);
  if (ignored > 0) parts.push(`${ignored} ignored`);
  await postMessage(webhookUrl, "\u{1F3B5} " + parts.join(" \xB7 "));
}
async function postMessage(webhookUrl, message) {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord uses "content", Slack accepts "text"; sending both covers both.
      body: JSON.stringify({ content: message, text: message })
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`Notify webhook ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("Notify webhook error:", e);
  }
}

// src/ledger.ts
var LEDGER_KEY = "ledger:v1";
var MAX_RECENT_SCROBBLES = 100;
var DEFAULT_LEDGER = {
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
    last_error_message: null
  }
};
async function loadLedger(kv) {
  try {
    const raw = await kv.get(LEDGER_KEY, "json");
    if (raw && typeof raw === "object") {
      return { ...DEFAULT_LEDGER, ...raw };
    }
  } catch (e) {
    console.warn("Ledger read failed, starting fresh:", e);
  }
  return { ...DEFAULT_LEDGER };
}
async function saveLedger(kv, ledger) {
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
}
function addRecentScrobbles(ledger, plays) {
  const newEntries = plays.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp_iso: p.timestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
    kind: p.kind
  }));
  ledger.recent_scrobbles = [...newEntries, ...ledger.recent_scrobbles].slice(
    0,
    MAX_RECENT_SCROBBLES
  );
}
function parseLastRunTime(ledger) {
  if (!ledger.last_run_iso) return null;
  const d = new Date(ledger.last_run_iso);
  return isNaN(d.getTime()) ? null : d;
}

// src/kv_keys.ts
var KV_KEY_APPLE_DEV_TOKEN = "apple_dev_token";
var KV_KEY_APPLE_USER_TOKEN = "apple_user_token";

// src/scrobbler.ts
async function pollAndScrobble(env) {
  const startedAt = Date.now();
  const runTime = new Date(startedAt);
  const ledger = await loadLedger(env.AMUSIC_STATE);
  const lastRunTime = parseLastRunTime(ledger);
  ledger.stats.total_runs += 1;
  ledger.last_run_iso = runTime.toISOString();
  const [appleDevToken, appleUserToken] = await Promise.all([
    env.AMUSIC_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.AMUSIC_STATE.get(KV_KEY_APPLE_USER_TOKEN)
  ]);
  if (!appleDevToken || !appleUserToken) {
    const msg = "apple_tokens_missing_in_kv";
    console.error(
      `${msg}: expected keys ${KV_KEY_APPLE_DEV_TOKEN} and ${KV_KEY_APPLE_USER_TOKEN}`
    );
    ledger.stats.total_errors += 1;
    ledger.stats.last_error_iso = runTime.toISOString();
    ledger.stats.last_error_message = msg;
    await saveLedger(env.AMUSIC_STATE, ledger);
    return {
      ok: false,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 1,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
      error_message: msg
    };
  }
  let current;
  try {
    current = await fetchRecentlyPlayed(appleDevToken, appleUserToken);
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      ledger.stats.total_errors += 1;
      ledger.stats.last_error_iso = runTime.toISOString();
      ledger.stats.last_error_message = "apple_token_expired";
      await saveLedger(env.AMUSIC_STATE, ledger);
      await notifyTokenExpired(env.NOTIFY_WEBHOOK_URL);
      return {
        ok: false,
        detected: 0,
        accepted: 0,
        ignored: 0,
        errors: 1,
        repeat_count: 0,
        elapsed_ms: Date.now() - startedAt,
        error_message: "apple_token_expired"
      };
    }
    throw e;
  }
  console.log(`Apple returned ${current.length} tracks`);
  if (ledger.previous_recent.length === 0) {
    console.log(`First run \u2014 snapshotting ${current.length} tracks without scrobbling`);
    ledger.previous_recent = current;
    await saveLedger(env.AMUSIC_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  const plays = detectPlays(current, ledger.previous_recent);
  if (plays.length === 0) {
    console.log("No new plays");
    ledger.previous_recent = current;
    await saveLedger(env.AMUSIC_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  console.log(`Detected ${plays.length} plays`);
  const timestamped = assignTimestamps(plays, runTime, lastRunTime);
  for (const p of timestamped) {
    console.log(
      `  [${p.kind}] ${p.track.artist} \u2014 ${p.track.name} @ ${p.timestamp?.toISOString()}`
    );
  }
  const payload = timestamped.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp: p.timestamp,
    duration_ms: p.track.duration_ms
  }));
  const lfmResult = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );
  console.log(
    `Last.fm: ${lfmResult.accepted} accepted, ${lfmResult.ignored} ignored, ${lfmResult.errors} errors`
  );
  if (env.LISTENBRAINZ_TOKEN) {
    const lbResult = await submitBatch(payload, env.LISTENBRAINZ_TOKEN);
    console.log(
      `ListenBrainz: ${lbResult.accepted} accepted, ${lbResult.errors} errors`
    );
  }
  const repeatCount = timestamped.filter((p) => p.kind === "repeat").length;
  await notifySummary(
    env.NOTIFY_WEBHOOK_URL,
    lfmResult.accepted,
    repeatCount,
    lfmResult.ignored
  );
  const oldTotal = ledger.stats.total_scrobbled;
  const newTotal = oldTotal + lfmResult.accepted;
  if (Math.floor(oldTotal / 1e3) < Math.floor(newTotal / 1e3)) {
    const milestone = Math.floor(newTotal / 1e3) * 1e3;
    await notifyMilestone(env.NOTIFY_WEBHOOK_URL, milestone);
  }
  addRecentScrobbles(ledger, timestamped);
  ledger.previous_recent = current;
  ledger.stats.total_scrobbled = newTotal;
  ledger.stats.last_success_iso = runTime.toISOString();
  await saveLedger(env.AMUSIC_STATE, ledger);
  return {
    ok: true,
    detected: plays.length,
    accepted: lfmResult.accepted,
    ignored: lfmResult.ignored,
    errors: lfmResult.errors,
    repeat_count: repeatCount,
    elapsed_ms: Date.now() - startedAt
  };
}
async function getStatus(env) {
  return loadLedger(env.AMUSIC_STATE);
}

// src/index.ts
var index_default = {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      pollAndScrobble(env).catch((err) => {
        console.error("scheduled() failed:", err);
      })
    );
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "amusic-scrobbler", version: "0.2.0" });
    }
    const providedKey = url.searchParams.get("key") ?? request.headers.get("x-amusic-auth") ?? "";
    if (!env.STATUS_AUTH_KEY || providedKey !== env.STATUS_AUTH_KEY) {
      return new Response("unauthorized", { status: 401 });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      const ledger = await getStatus(env);
      return json(ledger);
    }
    if (url.pathname === "/trigger" && request.method === "POST") {
      const runPromise = pollAndScrobble(env).catch((err) => {
        console.error("/trigger failed:", err);
        return null;
      });
      ctx.waitUntil(runPromise);
      return json({ ok: true, triggered: true });
    }
    return new Response("not found", { status: 404 });
  }
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
export {
  index_default as default
};
