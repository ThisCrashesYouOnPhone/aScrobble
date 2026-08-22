# aScrobble

> Free, self-hosted Apple Music → Last.fm scrobbler that tracks **everything** you play (including on iPhone & iOS) — runs 24/7 on Cloudflare.

[![GitHub stars](https://img.shields.io/github/stars/ThisCrashesYouOnPhone/aScrobble?style=flat)](https://github.com/ThisCrashesYouOnPhone/aScrobble)
[![GitHub release](https://img.shields.io/github/v/release/ThisCrashesYouOnPhone/aScrobble)](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ThisCrashesYouOnPhone/aScrobble/total?color=brightgreen)](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases)
[![Repo Views](https://komarev.com/ghpvc/?username=ThisCrashesYouOnPhone-aScrobble&label=Repo+Views&color=fc3c44&style=flat)](https://github.com/ThisCrashesYouOnPhone/aScrobble)
[![License](https://img.shields.io/github/license/ThisCrashesYouOnPhone/aScrobble)](LICENSE)

---

## ⬇️ Download

👉 **[Download latest release (v1.1.0)](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases/latest)**  

Available for **Windows** (`.exe`), **macOS** (Universal `.dmg`), and **Linux** (`.deb`, `.AppImage`).

Or browse all versions:  
https://github.com/ThisCrashesYouOnPhone/aScrobble/releases

---

## ⭐ Star History

<a href="https://www.star-history.com/?type=date&repos=ThisCrashesYouOnPhone%2FaScrobble">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ThisCrashesYouOnPhone/aScrobble&type=date&theme=dark&legend=top-left&sealed_token=DXIQQlHpfmA3VYLLbVvHoUMa09Dip0N2KoUgia62EU21dVtQGO8nASZu028r3RAQdJ0LTwqOPla224dO1sO6XJhNOAMEwHBpqoy98C28pMDLpXNyV438wA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ThisCrashesYouOnPhone/aScrobble&type=date&legend=top-left&sealed_token=DXIQQlHpfmA3VYLLbVvHoUMa09Dip0N2KoUgia62EU21dVtQGO8nASZu028r3RAQdJ0LTwqOPla224dO1sO6XJhNOAMEwHBpqoy98C28pMDLpXNyV438wA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ThisCrashesYouOnPhone/aScrobble&type=date&legend=top-left&sealed_token=DXIQQlHpfmA3VYLLbVvHoUMa09Dip0N2KoUgia62EU21dVtQGO8nASZu028r3RAQdJ0LTwqOPla224dO1sO6XJhNOAMEwHBpqoy98C28pMDLpXNyV438wA" />
 </picture>
</a>

---

## Quick start

**Requirements:**
- An Apple Music subscription  
- A free Last.fm account  
- A free Cloudflare account (no payment required)  
- A free Last.fm API application (the wizard guides you through setup)  

**Setup:**

1. Download and install aScrobble  
2. Open the app  
3. Click through the setup wizard: Apple Music → Last.fm → Cloudflare → Deploy  
4. Close the app  

Your scrobbler now runs 24/7 on Cloudflare — even when your PC or phone is turned off.  
Scrobbles typically appear within 1–5 minutes depending on your configured polling interval.

---

## What it actually does

aScrobble is a lightweight desktop app and Cloudflare Worker combo:

1. **Captures Apple Music tokens** via embedded webview (`music.apple.com`) and stores them in your OS keychain  
2. **Authenticates Last.fm** using a local OAuth loopback flow  
3. **Connects to Cloudflare** using your API token  
4. **Deploys a serverless Worker** that polls Apple Music's WebKit API every 1–5 minutes and scrobbles your listening history to Last.fm  

After initial deployment, everything runs serverless in your own Cloudflare account — no background processes on your PC, no iOS apps, no subscriptions.

---

## 📱 Works seamlessly on iPhone & iOS

Because Apple Music automatically syncs your recent listening history across devices to Apple's cloud servers, **aScrobble tracks plays from your iPhone, iPad, Apple Watch, Mac, Windows PC, HomePod, or Apple TV**.

- **Zero iPhone battery drain**: No background app or tracking daemon running on your phone.
- **No manual scrobbling**: Plays are picked up automatically by your Cloudflare Worker 24/7.
- **Tracks non-library tracks**: Scrobbles radio stations, algorithmic recommendations, custom playlists, and search plays — not just songs saved to your library.

---

## Why this exists

Most Apple Music scrobblers:
- only track library songs  
- require a phone app running in the background  
- force you to use their custom music player  
- or charge a monthly subscription  

aScrobble avoids all of that by running entirely on your own free Cloudflare infrastructure.

---

## Features

- **iPhone & Cross-Platform Support**: Scrobbles listening activity across iOS, Mac, PC, HomePod, and Web.
- **24/7 Cloud Execution**: Runs on Cloudflare's free tier (uses <10% of daily free quota).
- **In-App Auto Updater**: Checks for updates automatically and updates silently in 1 click.
- **Cloudflare Worker Auto-Sync**: 1-click worker resync from the dashboard whenever new worker features drop.
- **Adjustable Polling Interval**: Choose between 1m, 2m, 3m, 5m, or 10m polling live from the dashboard.
- **Stationary Guard Detection**: Smarter position-shift algorithm detects repeated track listens accurately.
- **In-App Token Rotation**: Refresh Apple Music tokens instantly without redeploying (`/update-tokens`).
- **Dashboard & Logs**: View recent scrobbles with album art, inspect detailed error logs, and clear stats in 1 click.
- **Optional Integrations**: Support for ListenBrainz and Discord/Slack notifications.

---

## Limitations

- **Estimated Scrobble Times**: Apple Music API does not return playback timestamps, so scrobble times are estimated from track duration and polling intervals (expect a couple minutes of drift).
- **Repeated Single Non-Library Track**: Replaying the exact same non-library song while it remains at position 0 may only record 1 play until another track plays.
- **Token Expiry**: Apple Music web tokens expire ~every 6 months (re-authenticating in the app takes ~10 seconds).

---

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
                        ▼
         Cloudflare Worker (1-5 min cron)
                        ▼
         Apple Music API → Last.fm API
```

---

## Security notes

- Tokens stored in OS keychain (never plaintext)  
- No external servers or telemetry  
- Everything runs in your own Cloudflare account  
- Worker endpoints protected by per-deploy authentication keys  

---

## Building from source

```bash
git clone https://github.com/ThisCrashesYouOnPhone/aScrobble
cd aScrobble
npm install
npm run tauri dev
npm run tauri build
```

---

## License

MIT

