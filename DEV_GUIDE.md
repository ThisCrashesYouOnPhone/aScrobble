# Development Guide

## Hot Reload Issues

### The Fast Fix (95% of the time)
```powershell
# Quick cache clear - only takes a few seconds
./scripts/clean-rebuild.ps1

# Then start dev
npm run tauri dev
```

This clears the caches that cause most issues (Vite dev server state and Rust compilation cache) but keeps node_modules intact. This is **fast** and **sufficient** for most development.

### The Nuclear Option (when something's really broken)
```powershell
# Full clean with npm reinstall
./scripts/clean-rebuild.ps1 --full
npm run tauri dev
```

Only do this if:
- npm packages are behaving weirdly
- You get strange module errors
- The quick fix didn't work

## Redeployment & Naming Conflicts

### Safe to redeploy multiple times

You can click "Deploy to Cloudflare" many times without issues. Here's how safety is guaranteed:

**Worker Script**
- Same name: `aScrobble-scrobbler`
- Using `PUT` not `POST`, so it **updates existing** worker instead of creating duplicates
- Each redeploy replaces the previous version

**KV Namespace**
- Name: `aScrobble-state`
- Fetched by name, reused if exists, created once if missing
- Data persists across redeploys (Apple tokens, sync state, etc.)

**Worker Secrets**
- `LASTFM_API_KEY`, `LASTFM_SESSION_KEY`, `LASTFM_SHARED_SECRET`, `STATUS_AUTH_KEY`
- Updated in place on each deploy
- No accumulation or conflicts

**Workers.dev Route**
- Pattern: `aScrobble-scrobbler.{subdomain}.workers.dev/*`
- Created once, reused on subsequent deploys
- Safe — Cloudflare deduplicates routes automatically

**Bottom line:** You can safely redeploy as many times as you want. The old version is replaced, no duplicates or conflicts.

## Redeployment Safety

### Safe to redeploy multiple times

You can click "Deploy to Cloudflare" many times without issues. Here's how safety is guaranteed:

**Worker Script**
- Same name: `aScrobble-scrobbler`
- Using `PUT` not `POST`, so it **updates existing** worker instead of creating duplicates
- Each redeploy replaces the previous version

**KV Namespace**
- Name: `aScrobble-state`
- Fetched by name, reused if exists, created once if missing
- Data persists across redeploys (Apple tokens, sync state, etc.)

**Worker Secrets**
- `LASTFM_API_KEY`, `LASTFM_SESSION_KEY`, `LASTFM_SHARED_SECRET`, `STATUS_AUTH_KEY`
- Updated in place on each deploy
- No accumulation or conflicts

**Cron Trigger**
- Updated via `PUT` on each deploy
- No conflicts

**Bottom line:** You can safely redeploy as many times as you want. The old version is replaced, no duplicates or conflicts.

## Cloudflare Authentication Methods

aScrobble supports two ways to authenticate with Cloudflare:

### 1. OAuth (Recommended - Easier)
Click "Login with Cloudflare" in the app. You'll authenticate in your browser.

**Pros:**
- No manual token creation
- Automatic account discovery
- Permissions are clearly defined

**Cons:**
- May have permission scope limitations (still investigating)
- Requires browser access

### 2. API Token (Fallback - More Control)
Create a token manually in Cloudflare dashboard and paste it in the app.

**Pros:**
- Full control over permissions
- Can use existing tokens
- Works regardless of browser issues

**Cons:**
- More setup steps
- Must create token manually in Cloudflare

### If workers.dev URL doesn't work:

1. **Try the API Token method** - If OAuth fails but API token works, it's a permissions issue
   - Go to Cloudflare dashboard > API Tokens > Create Token
   - Use "Edit Cloudflare Workers" template
   - Paste in aScrobble's "Advanced: paste API token instead" section

2. **Check your workers.dev subdomain** - Must be set up in Cloudflare
   - Go to Cloudflare dashboard > Workers > Settings
   - Look for "Workers subdomain" - if not set, create one

3. **Enable URLs in Worker settings** - Make sure workers.dev is enabled
   - Go to Cloudflare dashboard > Worker > Settings
   - Look for "Domains & Routes"
   - workers.dev should show as enabled

## Why Changes Don't Show Up

1. **Vite dev server gets stuck** (most common)
   - Fix: Restart the dev process (Ctrl+C, then `npm run tauri dev`)

2. **Rust code changes aren't picked up**
   - Fix: `./scripts/clean-rebuild.ps1` then restart
   - The Rust compiler cache (`target/debug/`) holds stale builds

3. **Frontend changes don't hot-reload**
   - Usually auto-fixes on save, but restart helps
   - Clear dist folder: `./scripts/clean-rebuild.ps1`

## Development Workflow

### For Frontend Changes (React/TypeScript)
- Changes to `src/**/*.tsx` or `src/**/*.ts` should **hot-reload** automatically
- If not, just restart the dev process (doesn't require a full clean)

### For Backend Changes (Rust)
- Changes to `src-tauri/src/**/*.rs` **require app restart**
- The app will rebuild automatically, but if code doesn't update:
  ```powershell
  ./scripts/clean-rebuild.ps1
  npm run tauri dev  # Restart with fresh Rust build
  ```

### For Worker Changes
Changes to `worker/src/**/*.ts` require rebuilding the bundled worker:
```powershell
npm run build-worker
npm run tauri dev  # Restart to use new worker bundle
```

## Redeployment Safety Details

If you're worried about repeated deployments creating crud on your Cloudflare account, here's the technical safeguard:

| Component | Behavior | Safe to Redeploy? |
|-----------|----------|-------------------|
| Worker Script | Uploaded via `PUT`, replaces existing | ✅ Yes |
| KV Namespace | Looked up by name, reused if exists | ✅ Yes |
| Secrets | Updated in place via `PUT` | ✅ Yes |
| Cron Trigger | Updated via `PUT` | ✅ Yes |
| Workers.dev Route | Created via `POST`, deduped by pattern | ✅ Yes |

Even if the app crashes mid-deploy, the next deploy will complete the missing pieces cleanly.

### What you'll see in Cloudflare dashboard

Each redeploy creates a new **version** (the hash like `89414c61`), but they're all the same worker script. The dashboard will show many versions — this is normal and expected. All previous versions are archived automatically.

## Common Scenarios

| Issue | Solution | Speed |
|-------|----------|-------|
| Frontend code not updating | Restart dev process (Ctrl+C, rerun) | ~5 sec |
| Rust code not updating | `./scripts/clean-rebuild.ps1` + restart | ~10 sec |
| Everything broken | `./scripts/clean-rebuild.ps1 --full` | ~30 sec |
| npm errors, missing packages | `./scripts/clean-rebuild.ps1 --full` | ~30 sec |

## Useful Commands

- `npm run dev` - Start Vite dev server only (for frontend work)
- `npm run build` - Build frontend for production
- `npm run tauri dev` - Full Tauri dev (frontend + Rust)
- `npm run tauri build` - Create production bundle
- `npm run build-worker` - Rebuild the Cloudflare Worker bundled code
- `./scripts/clean-rebuild.ps1` - Quick cache clear
- `./scripts/clean-rebuild.ps1 --full` - Full clean with npm reinstall

## Testing Locally

### Test the deployment flow without Cloudflare
You can inspect what gets deployed by checking:
- Built worker code: Check `src-tauri/resources/worker.js` (this gets bundled)
- Deployment logs: Watch the progress events in the Deploy step

### Enable debug logging
Set these env vars before running:
```powershell
$env:RUST_LOG="debug"
npm run tauri dev
```

This will print all Rust debug logs to the terminal, helpful for diagnosing deployment issues and credential sync issues.

## Debugging Keychain Issues

### Credentials disappear after saving

If credentials appear to save but then vanish when you navigate to the next step:

1. **Enable debug logging** to see what's being saved and loaded:
```powershell
$env:RUST_LOG="debug"
npm run tauri dev
```

2. **Watch the terminal** output for messages like:
   - `✓ Apple tokens saved to keychain successfully`
   - `Loaded credentials: apple=true, lastfm=...`

3. **Common causes:**
   - **Windows Credential Manager sync delay** — Try adding a small wait after save (already implemented)
   - **Keychain locked** — Check Windows Credential Manager isn't prompting
   - **Permissions issue** — Ensure the app has keyring access

4. **If credentials still disappear:**
   - Clear all credentials: In the app, go to Dashboard → "Reset everything"
   - Try re-authenticating all three services
   - Check Windows Event Viewer for credential manager errors

### Credential Manager access on Windows

The app stores credentials using the Windows Credential Manager. To check what's saved:

```powershell
# View all stored credentials
cmdkey /list

# Look for entries starting with "dev.aScrobble.app"
```

To manually clear aScrobble credentials:

```powershell
cmdkey /delete:dev.aScrobble.app:apple-tokens
cmdkey /delete:dev.aScrobble.app:lastfm-session
# etc.
```
