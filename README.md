# aScrobble

> Free, self-hosted Apple Music → Last.fm scrobbler that tracks **everything** you play — runs 24/7 on Cloudflare.

[![GitHub stars](https://img.shields.io/github/stars/ThisCrashesYouOnPhone/aScrobble?style=flat)](https://github.com/ThisCrashesYouOnPhone/aScrobble)
[![GitHub release](https://img.shields.io/github/v/release/ThisCrashesYouOnPhone/aScrobble)](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ThisCrashesYouOnPhone/aScrobble/total)](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases)
[![License](https://img.shields.io/github/license/ThisCrashesYouOnPhone/aScrobble)](LICENSE)

---

## ⬇️ Download

👉 **[Download latest release](https://github.com/ThisCrashesYouOnPhone/aScrobble/releases/latest)**  

Or browse all versions:  
https://github.com/ThisCrashesYouOnPhone/aScrobble/releases

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ThisCrashesYouOnPhone/aScrobble&type=Date)](https://star-history.com/#ThisCrashesYouOnPhone/aScrobble&Date)

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
3. Click through the wizard: Apple Music → Last.fm → Cloudflare → Deploy  
4. Close the app  

Your scrobbler now runs 24/7 on Cloudflare — even when your PC is off.  
Scrobbles typically appear within 5–10 minutes.

---

## What it actually does

aScrobble is a single-binary Tauri app that:

1. **Captures Apple Music tokens** via embedded webview (`music.apple.com`) and stores them in your OS keychain  
2. **Authenticates Last.fm** using a local OAuth loopback flow  
3. **Connects to Cloudflare** using your API token  
4. **Deploys a worker** that runs every 5 minutes and scrobbles your listening history  

After deploy, everything runs in your own Cloudflare account — no servers, no subscriptions.

---

## Why this exists

Most Apple Music scrobblers:
- only track library songs  
- require a phone app  
- or charge a subscription  

aScrobble avoids all of that by running entirely on your own infrastructure.

---

## Features

- Tracks all Apple Music plays (library, radio, recommendations, search)  
- Runs 24/7 on Cloudflare free tier  
- No subscription or backend  
- PC does not need to stay on  
- Detects repeated plays using position-shift algorithm  
- Auto token rotation (no redeploy needed)  
- Optional integrations: ListenBrainz + Discord/Slack  

---

## Limitations

- Apple Music API provides no timestamps → times are inferred (few minutes drift)  
- Replaying a song already at position 0 may not be detected  
- Tokens expire ~every 6 months (quick re-auth fixes it)  
- Recent tracks API is limited to ~50 items  

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
         Cloudflare Worker (5 min cron)
                        ▼
         Apple Music API → Last.fm API
```

---

## Security notes

- Tokens stored in OS keychain (never plaintext)  
- No external servers or telemetry  
- Everything runs in your Cloudflare account  
- Worker endpoints protected by per-deploy auth key  

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