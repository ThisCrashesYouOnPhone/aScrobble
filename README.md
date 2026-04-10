# aScrobble

[![GitHub stars](https://img.shields.io/github/stars/ThisCrashesYouOnPhone/aScrobble?style=flat)](https://github.com/ThisCrashesYouOnPhone/aScrobble)

A desktop deployment wizard that puts an Apple Music → Last.fm scrobbler on your own Cloudflare account. Click through three auth steps, click Deploy, and walk away — the scrobbler runs forever in the cloud at zero cost. Your PC can be off.

## What it actually does

aScrobble is a single-binary Tauri app that:

1. **Captures Apple Music tokens** by spawning an embedded webview to `music.apple.com`. You sign in with Apple ID and 2FA exactly as you would in any browser. aScrobble reads `MusicKit.getInstance().developerToken` and `.musicUserToken` from the page and stores them in your OS keychain.
2. **Captures a Last.fm session** via the standards-compliant RFC 8252 loopback OAuth flow. aScrobble spins up a temporary localhost HTTP server, opens Last.fm's auth page in your default browser, catches the redirect, and exchanges the temporary token for a permanent session key.
3. **Captures a Cloudflare API token** that you create in your dashboard via a pre-filled "Edit Cloudflare Workers" template link. aScrobble validates it and lists your accounts so you can pick which one hosts the scrobbler.
4. **Deploys the scrobbler.** A bundled `worker.js` is uploaded to your Cloudflare account along with: a KV namespace for state, four worker secrets (Last.fm credentials + a generated admin secret), seeded Apple tokens in KV, and a 5-minute cron trigger.

After deploy, the worker polls the Apple Music recently-played API every 5 minutes, detects new and repeat plays via a position-shift diffing algorithm, walks each play's duration backwards from the poll time to assign realistic timestamps, and submits to Last.fm.

## Architecture

```
┌────────────────────────────────────────────────┐
│             aScrobble desktop app              │
│                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Apple   │  │ Last.fm  │  │  Cloudflare  │  │
│  │ webview  │  │ loopback │  │  API token   │  │
│  └────┬─────┘  └─────┬────┘  └──────┬───────┘  │
│       │              │              │          │
│       ▼              ▼              ▼          │
│   ┌────────────────────────────────────┐       │
│   │      OS keychain (secure store)    │       │
│   └────────────────────────────────────┘       │
│                       │                        │
│                       ▼                        │
│   ┌────────────────────────────────────┐       │
│   │    Cloudflare deployment module    │       │
│   │   (deploy.rs — REST API client)    │       │
│   └────────────────────────────────────┘       │
└───────────────────────┬────────────────────────┘
                        │ PUT /workers/scripts/...
                        │ PUT /storage/kv/...
                        │ PUT /schedules
                        ▼
┌────────────────────────────────────────────────┐
│         Your own Cloudflare account            │
│                                                │
│   ┌─────────────────────┐  ┌────────────────┐  │
│   │  ascrobble-scrobbler│──│ ascrobble-state│  │
│   │  Worker (5-min cron)│  │  KV namespace  │  │
│   └──────────┬──────────┘  │                │  │
│              │             │ • ledger:v1    │  │
│              │             │ • apple_dev_…  │  │
│              │             │ • apple_user…  │  │
│              │             └────────────────┘  │
└──────────────┼─────────────────────────────────┘
               │ every 5 minutes
               ▼
         Apple Music API → Last.fm API
                            └→ ListenBrainz (optional)
```

The deployed worker is built from TypeScript source in `worker/` (not a hand-written
single-file script). At aScrobble build time, esbuild bundles `worker/src/index.ts`
and its dependencies into a single ~22kb ESM file at `worker/dist/worker.js`,
which is then copied into `src-tauri/resources/worker.js` and bundled inside
the desktop installer as a Tauri resource. At deploy time, `deploy.rs` reads
that resource and uploads it to Cloudflare via the REST API — no `wrangler`
binary required on the user's machine.

**Why Apple tokens live in KV:** Worker secrets are immutable per deploy in Cloudflare's model (changing one requires re-uploading the entire script). KV values are mutable via simple `PUT` calls. So aScrobble seeds Apple tokens to KV at deploy time, and when they expire (~6 months), the app can rotate them with two KV `PUT`s instead of a full redeploy.

## Quick start

**Requirements:**
- An Apple Music subscription
- A free Last.fm account
- A free Cloudflare account (no payment required)
- A free Last.fm API application (the wizard guides you through setup)

**Installation:**

1. Download the latest release for your platform from the [Releases page](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases)
2. Run the installer and launch aScrobble
3. Click through the wizard: Apple Music → Last.fm → Cloudflare → Deploy
4. Close the app

Your scrobbler is now live on Cloudflare and will run 24/7 — even when your PC is off. Play music and scrobbles will appear on Last.fm within 5–10 minutes.

## Features

✅ **Zero running costs** — runs on Cloudflare's free tier

✅ **PC doesn't need to be on** — works 24/7 in the cloud

✅ **Detects repeated plays** — position-shift algorithm + optional play count verification

✅ **Auto-rotating tokens** — Apple tokens renewed without redeploying

✅ **Optional integrations** — ListenBrainz and Discord/Slack webhooks

✅ **Auto-updates** — notifies you when new versions are available

⚠️ **Limitations:**
- Apple Music API returns no metadata — timestamps are inferred from poll time and track duration
- Cloudflare secrets propagate in ~15 seconds on first deploy (progress bar shows "Waiting for worker to be ready")
- Cannot detect backfilled/offline plays in Apple Music

## Building from source

```bash
git clone https://github.com/ThisCrashesYouOnPhone/aScrobble
cd aScrobble
npm install
npm run tauri dev          # development mode (frontend hot-reload)
npm run tauri build        # production build (outputs installer)
```

`npm run tauri build` automatically chains the worker bundling step before
the desktop bundle: it runs `scripts/build-worker.mjs` which installs the
worker's own dependencies (esbuild, typescript, @cloudflare/workers-types)
on first run, bundles `worker/src/index.ts` to `worker/dist/worker.js`,
and copies the result into `src-tauri/resources/worker.js` so Cargo can
embed it as a Tauri resource.

If you want to verify the worker bundles without running the full Tauri
build:

```bash
npm run build:worker       # just the worker bundling step
cd worker && npm run typecheck   # tsc --noEmit on the TypeScript source
```

Requirements:
- **Node.js 20+**
- **Rust toolchain** via [rustup](https://rustup.rs/)
- Platform deps:
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `pkg-config`
  - **macOS**: Xcode command line tools
  - **Windows**: WebView2 runtime (preinstalled on Win10+ generally)

## Project structure

```
aScrobble/
├── src/                              React frontend (TypeScript)
│   ├── components/
│   │   ├── Welcome.tsx              landing screen
│   │   ├── Stepper.tsx              progress indicator
│   │   ├── AppleStep.tsx            embedded webview auth
│   │   ├── LastfmStep.tsx           OAuth loopback auth
│   │   ├── CloudflareStep.tsx       API token paste flow
│   │   ├── DeployStep.tsx           live deploy progress
│   │   └── DoneStep.tsx             success screen
│   ├── lib/tauri.ts                 typed invoke() wrappers
│   ├── types.ts                     shared DTOs
│   ├── App.tsx                      wizard orchestrator
│   ├── main.tsx                     React entry
│   └── styles.css                   complete dark theme
├── src-tauri/                        Rust host
│   ├── src/
│   │   ├── main.rs                  binary entry
│   │   ├── lib.rs                   Tauri builder + plugin setup
│   │   ├── commands.rs              #[tauri::command] surface
│   │   ├── auth/
│   │   │   ├── apple.rs             webview spawn + token capture
│   │   │   ├── lastfm.rs            loopback OAuth + signed exchange
│   │   │   └── cloudflare.rs        token validation + account listing
│   │   ├── deploy.rs                Cloudflare deployment orchestration
│   │   └── storage.rs               OS keychain wrapper
│   ├── resources/
│   │   └── worker.js                bundled scrobbler (regenerated by build)
│   ├── icons/                       app icons (PIL placeholders)
│   ├── capabilities/default.json    Tauri 2 permission manifest
│   ├── tauri.conf.json
│   └── Cargo.toml
├── worker/                           Cloudflare Worker source (TypeScript)
│   ├── src/
│   │   ├── index.ts                 entry: scheduled() + fetch() handlers
│   │   ├── scrobbler.ts             orchestrator (poll → detect → submit)
│   │   ├── apple.ts                 Apple Music API client
│   │   ├── detect.ts                position-shift play detection
│   │   ├── timestamps.ts            backward duration walk
│   │   ├── lastfm.ts                track.scrobble + signing
│   │   ├── md5.ts                   pure-TS MD5 (no node:crypto)
│   │   ├── ledger.ts                KV state read/write
│   │   ├── kv_keys.ts               KV key constants (shared with deploy.rs)
│   │   ├── env.ts                   Env interface
│   │   ├── listenbrainz.ts          optional dual-target submission
│   │   └── notify.ts                optional Discord/Slack webhook
│   ├── dist/worker.js               esbuild output (gitignored)
│   ├── wrangler.toml                local dev only
│   ├── tsconfig.json
│   └── package.json
├── scripts/
│   └── build-worker.mjs             chained from `npm run build`
├── index.html
├── package.json                     root scripts: build chains worker→frontend
├── tsconfig.json
└── vite.config.ts
```

### Build pipeline

```
$ npm run tauri build
        │
        └─→ tauri build
                │
                ├─→ beforeBuildCommand: "npm run build"
                │       │
                │       ├─→ npm run build:worker
                │       │       └─→ node scripts/build-worker.mjs
                │       │               ├─→ npm install (in worker/, if needed)
                │       │               ├─→ esbuild → worker/dist/worker.js
                │       │               └─→ copy → src-tauri/resources/worker.js
                │       │
                │       └─→ npm run build:frontend
                │               └─→ tsc && vite build → dist/
                │
                ├─→ cargo build --release
                │       └─→ embeds src-tauri/resources/worker.js as a resource
                │
                └─→ bundle installer for current platform
```

## Security notes

- **Tokens never live in plaintext on disk.** The Apple tokens, Last.fm credentials, and Cloudflare API token are stored in your OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service).
- **No server runs anywhere we control.** aScrobble is a deployment tool. It pushes the scrobbler directly from your machine to your Cloudflare account. We have no backend, no telemetry, no analytics.
- **The worker secret values live only on Cloudflare** after deploy. The desktop app keeps a local copy in the keychain so you can rotate credentials without re-authenticating from scratch.
- **The `STATUS_AUTH_KEY`** that protects the worker's `/status` and `/trigger` endpoints is randomly generated per deploy (32 bytes from the OS RNG, base64-url encoded). It's stored as a Cloudflare worker secret and in your local OS keychain. Without it, anyone could read your scrobble history or trigger arbitrary polls by guessing your `workers.dev` URL.
- **Apple tokens are stored in KV, not as worker secrets.** This is intentional — KV values are mutable while worker secrets require a redeploy to change. When your Apple tokens expire (every ~6 months), the desktop app rotates them with two `PUT` calls instead of a full redeploy.

## How the scrobbling actually works

The bundled `worker.js` runs on Cloudflare's cron schedule (`*/5 * * * *`) and does this on every tick:

1. Read `apple_dev_token` and `apple_user_token` from KV (the `ASCRIBBLE_STATE` namespace)
2. Fetch `GET /v1/me/recent/played/tracks` from Apple Music API, paginated 5 times to get up to 50 most-recent tracks
3. Load the previous-poll snapshot from KV (`ledger:v1` key, also in `ASCRIBBLE_STATE`)
4. Run the position-shift detection algorithm:
   - Find the smallest K such that `current[K:] === previous[:len(current)-K]`
   - The first K entries of `current` are new plays
   - If no valid K (Apple reorganized the list), fall back to per-track position tracking to detect "moved up" repeats
5. Walk each play's duration backwards from "now" to assign timestamps
6. Submit to Last.fm via signed `track.scrobble` API (signed with pure-TS MD5 — no `nodejs_compat` flag needed)
7. Optionally also submit to ListenBrainz (if `LISTENBRAINZ_TOKEN` secret is set)
8. Optionally fire a Discord/Slack webhook with a summary (if `NOTIFY_WEBHOOK_URL` is set)
9. Save the new snapshot back to KV, increment counters, persist any errors

The worker also exposes three HTTP endpoints on its `workers.dev` URL:

| Method | Path       | Auth                          | Purpose                          |
|--------|------------|-------------------------------|----------------------------------|
| GET    | `/health`  | open                          | liveness check                   |
| GET    | `/status`  | `STATUS_AUTH_KEY` query/header | full ledger JSON                 |
| POST   | `/trigger` | `STATUS_AUTH_KEY` query/header | manual run (for testing/rotation) |

The auth key is randomly generated per deploy (32 bytes from the OS RNG, base64-url encoded) and stored both as a Cloudflare Worker secret and in your local OS keychain. It exists so random scanners hitting your `workers.dev` URL can't read your scrobble history or trigger arbitrary polls.

The detection algorithm correctly handles consecutive plays of the same song — Apple's API returns duplicate entries and the position-shift algorithm catches all of them as separate plays. (See the Limitations section below for the one case it still can't catch.)

## Limitations

- **Tokens expire ~every 6 months.** Apple's developer token and Music User Token both have a finite lifetime. When they expire, the worker logs `apple_token_expired` and stops scrobbling. Re-open aScrobble and re-authenticate Apple Music — your other credentials stay in place.
- **Replays of a song already at position 0** can't be detected. If Apple chooses to overwrite-in-place rather than add a duplicate entry to the recent-played list, the API gives us zero signal that anything happened. Future versions may add library `playCount` tracking to fix this at the cost of 10× more API calls per poll.
- **The 50-track API window can overflow** if you play more than ~50 tracks in 5 minutes. Realistically that's hard to hit unless you queue-skip nonstop.
- **GitHub Actions cron is unreliable below 10 minutes** — that's why we use Cloudflare Workers. CF cron triggers fire reliably at 5-minute intervals.

## Roadmap

**v2.0** (this release)
- Three-service auth + deploy wizard
- Cloudflare Workers cron at 5-minute intervals
- Position-shift play detection (fixes the "successive plays" bug)
- Heuristic timestamp reconstruction
- OS keychain credential storage

**v2.1**
- Token rotation flow (re-authenticate Apple without redeploying)
- Public `/status` endpoint via workers.dev subdomain
- Live deploy status pulled into the desktop app

**v2.2**
- Optional ListenBrainz dual-target submission
- Discord/Slack webhook for token expiry alerts and milestones

**v2.3**
- Library `playCount` tracking to fix the "already at position 0" replay case
- iOS Shortcuts hybrid for real timestamps (the only path to perfect accuracy)

## License

MIT
