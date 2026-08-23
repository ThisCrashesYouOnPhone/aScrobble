import { useEffect, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { StoredCredentials, WorkerLedger, UserSettings, LogEntry } from "../types";
import {
  getWorkerUrl,
  getStatusAuthKey,
  rotateAppleTokens,
  loadUserSettings,
  storageClearAll,
  updatePollInterval,
  redeployWorker,
  appleDecodeTokenExpiry,
} from "../lib/tauri";
import { fetchStatus, triggerScrobble, fetchLastfmAlbumArt, resetWorkerStats } from "../lib/worker-api";

interface DashboardProps {
  creds: StoredCredentials;
  onReset: () => void;
  onStatusChange?: (status: { color: string; text: string }) => void;
}

interface AlbumArtCache {
  [key: string]: string | null;
}

const INTERVAL_OPTIONS = [
  { value: 1, label: "1 min" },
  { value: 2, label: "2 min" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
] as const;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCountdown(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function daysUntilExpiry(capturedAt: string, actualExpiry?: string | null): number {
  let expiresAt: number;
  if (actualExpiry) {
    expiresAt = new Date(actualExpiry).getTime();
  } else {
    const captured = new Date(capturedAt).getTime();
    expiresAt = captured + 180 * 24 * 60 * 60 * 1000;
  }
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Scrobbles Modal Component
function ScrobblesModal({ 
  scrobbles, 
  albumArtCache, 
  onClose, 
  onTrackClick 
}: { 
  scrobbles: WorkerLedger['recent_scrobbles'];
  albumArtCache: AlbumArtCache;
  onClose: () => void;
  onTrackClick: (s: any) => void;
}) {
  const [page, setPage] = useState(0);
  const itemsPerPage = 20;
  
  // Sort by timestamp descending (newest first)
  const sortedScrobbles = [...scrobbles].sort((a, b) => 
    new Date(b.timestamp_iso).getTime() - new Date(a.timestamp_iso).getTime()
  );
  
  const totalPages = Math.ceil(sortedScrobbles.length / itemsPerPage);
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = sortedScrobbles.slice(start, end);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>All Recent Scrobbles</h3>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body modal-body-scrollable">
          <div className="scrobble-list">
            {pageItems.map((s, i) => {
              const cacheKey = `${s.artist}|${s.album}`;
              const albumArt = albumArtCache[cacheKey];
              const actualIndex = start + i;
              
              return (
                <div
                  key={actualIndex}
                  className={`scrobble-row ${actualIndex === 0 ? 'scrobble-row--latest' : ''}`}
                  onClick={() => onTrackClick(s)}
                >
                  <div className="scrobble-row-number">{actualIndex + 1}</div>
                  <div className="scrobble-row-art">
                    {albumArt ? (
                      <img src={albumArt} alt={s.album} loading="lazy" />
                    ) : (
                      <div className="scrobble-row-art-placeholder">
                        <span>♪</span>
                      </div>
                    )}
                    {actualIndex === 0 && <div className="scrobble-now-playing" />}
                  </div>
                  <div className="scrobble-row-info">
                    <div className="scrobble-row-track" title={s.track}>{s.track}</div>
                    <div className="scrobble-row-meta">
                      <span className="scrobble-row-artist" title={s.artist}>{s.artist}</span>
                      <span className="scrobble-row-separator">•</span>
                      <span className="scrobble-row-album" title={s.album}>{s.album}</span>
                    </div>
                  </div>
                  <div className="scrobble-row-right">
                    {s.kind === "new" && <span className="scrobble-badge" title="New play">♫</span>}
                    <span className="scrobble-row-time">{relativeTime(s.timestamp_iso)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {totalPages > 1 && (
          <div className="modal-actions">
            <div className="pagination">
              <button 
                className="btn btn-sm" 
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                ← Previous
              </button>
              <span className="pagination-info">
                Page {page + 1} of {totalPages}
              </span>
              <button 
                className="btn btn-sm" 
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Dashboard({ creds, onReset, onStatusChange }: DashboardProps) {
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);
  const [authKey, setAuthKey] = useState<string | null>(null);
  const [ledger, setLedger] = useState<WorkerLedger | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings>({ poll_interval_minutes: 1 });
  const [confirmReset, setConfirmReset] = useState(false);
  const [subdomainMissing, setSubdomainMissing] = useState(false);
  const [albumArtCache, setAlbumArtCache] = useState<AlbumArtCache>({});
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [showAllScrobbles, setShowAllScrobbles] = useState(false);
  const [decodedAppleExpiry, setDecodedAppleExpiry] = useState<string | null>(creds.apple?.expires_at || null);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; body: string | null } | null>(null);
  const [updateObject, setUpdateObject] = useState<any>(null);
  const [showUpdateNotes, setShowUpdateNotes] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [firstRunPending, setFirstRunPending] = useState(false);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [resetToast, setResetToast] = useState<string | null>(null);
  const [showWorkerLog, setShowWorkerLog] = useState(false);
  const [workerOutOfSync, setWorkerOutOfSync] = useState(false);
  const [syncingWorker, setSyncingWorker] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!workerUrl || !authKey) return;
    try {
      const data = await fetchStatus(workerUrl, authKey);
      setLedger(data);
      setStatusError(null);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setStatusError(msg);
    }
  }, [workerUrl, authKey]);

  // Countdown ticker: pure UI, NEVER triggers reads.
  // Depends only on last_run_iso — smooth rollover, never freezes on "Polling..."
  useEffect(() => {
    if (!ledger?.last_run_iso) {
      setCountdownSec(null);
      return;
    }
    const intervalMs = (settings.poll_interval_minutes || 1) * 60_000;
    const lastRunMs = new Date(ledger.last_run_iso).getTime();
    const nextCronMs = lastRunMs + intervalMs;

    const tick = () => {
      const rawDiff = Math.ceil((nextCronMs - Date.now()) / 1000);
      // Smooth rollover: never freeze at 0
      setCountdownSec(rawDiff > 0 ? rawDiff : (((rawDiff % 60) + 60) % 60));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [ledger?.last_run_iso, settings.poll_interval_minutes]);

  // Status polling: simple flat interval, no cascade risk.
  // 12s interval = max 12s delay after a scrobble, uses ~7,200 reads/day (7.2% of free quota).
  // Manual trigger via handleTrigger already returns fresh ledger instantly from the HTTP response.
  useEffect(() => {
    if (!workerUrl || !authKey) return;
    const interval = setInterval(refreshStatus, 12_000);
    return () => clearInterval(interval);
  }, [workerUrl, authKey, refreshStatus]);

  // Auto-trigger a catchup poll on mount/launch if last run was > 2 minutes ago
  useEffect(() => {
    if (!ledger?.last_run_iso || !workerUrl || !authKey) return;
    const lastRunMs = new Date(ledger.last_run_iso).getTime();
    const gapMs = Date.now() - lastRunMs;
    const intervalMs = (settings.poll_interval_minutes || 1) * 60_000;

    if (gapMs > intervalMs * 2) {
      console.log("Gap detected (> 2m ago). Firing automatic catch-up poll...");
      triggerScrobble(workerUrl, authKey)
        .then(() => setTimeout(refreshStatus, 2500))
        .catch(console.error);
    }
  }, [ledger?.last_run_iso, workerUrl, authKey, settings.poll_interval_minutes, refreshStatus]);

  // Notify parent of status changes
  useEffect(() => {
    if (!onStatusChange) return;
    let color = "gray";
    let text = "Unknown";
    if (!ledger) { color = "gray"; text = "No data"; }
    else if (statusError) { color = "red"; text = "Error"; }
    else if (ledger.last_run_iso && Date.now() - new Date(ledger.last_run_iso).getTime() < (settings.poll_interval_minutes + 5) * 60_000) { color = "green"; text = "Running"; }
    else { color = "yellow"; text = "Stale"; }
    onStatusChange({ color, text });
  }, [ledger, settings.poll_interval_minutes, statusError, onStatusChange]);

  const handleResetStats = async () => {
    if (!workerUrl || !authKey) return;
    try {
      let updated: WorkerLedger;
      try {
        updated = await resetWorkerStats(workerUrl, authKey);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("404") || msg.includes("Reset stats HTTP 404")) {
          setResetToast("Updating worker code on Cloudflare...");
          await redeployWorker();
          updated = await resetWorkerStats(workerUrl, authKey);
        } else {
          throw err;
        }
      }
      setLedger(updated);
      setStatusError(null);
      setResetToast("Error log cleared ✓");
      setTimeout(() => setResetToast(null), 3000);
    } catch (e) {
      console.error("Failed to reset worker stats:", e);
      const msg = typeof e === "string" ? e : (e as Error).message;
      setStatusError(`Failed to clear errors: ${msg}`);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const [url, key, userSettings] = await Promise.all([
          getWorkerUrl(),
          getStatusAuthKey(),
          loadUserSettings(),
        ]);
        setWorkerUrl(url);
        setAuthKey(key);
        setSettings(userSettings);
        
        console.log("Dashboard init:", {
          hasUrl: !!url,
          url: url ? `${url.split('.workers.dev')[0]}.workers.dev/*` : null,
          hasKey: !!key,
        });
        
        if (!url) {
          console.warn("No worker URL found - worker may not be deployed or route not set up");
          setSubdomainMissing(true);
          setLoading(false);
          return;
        }
        
        if (url && key) {
          try {
            const data = await fetchStatus(url, key);
            setLedger(data);
            setStatusError(null);
            // Fresh deploy: worker is live but hasn't run its first cron yet
            if (!data.last_run_iso && data.stats.total_runs === 0) {
              setFirstRunPending(true);
            }
          } catch (e) {
            const msg = typeof e === "string" ? e : (e as Error).message;
            // If the /status endpoint fails immediately after a deploy, it
            // likely just means the worker hasn't served its first request
            // yet. Show a friendlier "pending" state instead of a red error.
            if (msg?.includes("401") || msg?.includes("403") || msg?.includes("fetch")) {
              setFirstRunPending(true);
            } else {
              setStatusError(msg);
            }
          }
        }

        // Non-blocking update check — never throws into the main catch
        checkUpdate().then((update) => {
          if (update?.available) {
            setUpdateAvailable({ version: update.version, body: update.body ?? null });
            setUpdateObject(update);
          }
        }).catch(() => { /* no update server configured yet, or offline */ });

        // Worker-sync check: if localStorage records a different app version
        // than the one running now, a relaunch after an update just happened.
        // Prompt the user to redeploy so the worker code stays in sync.
        const APP_VERSION = "1.1.2";
        const storedWorkerSyncVersion = localStorage.getItem("ascrobble_worker_sync_version");
        if (storedWorkerSyncVersion && storedWorkerSyncVersion !== APP_VERSION) {
          setWorkerOutOfSync(true);
        }
        // Always write the current version so we detect future updates
        localStorage.setItem("ascrobble_worker_sync_version", APP_VERSION);
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error).message;
        console.error("Dashboard initialization error:", msg);
        setStatusError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Decode Apple token expiry on mount if not already available
  useEffect(() => {
    (async () => {
      if (creds.apple?.developer_token && !decodedAppleExpiry) {
        try {
          const expiry = await appleDecodeTokenExpiry(creds.apple.developer_token);
          if (expiry) {
            console.log("Decoded Apple token expiry:", expiry);
            setDecodedAppleExpiry(expiry);
          }
        } catch (e) {
          console.warn("Failed to decode Apple token expiry:", e);
        }
      }
    })();
  }, [creds.apple?.developer_token, decodedAppleExpiry]);

  // Smart polling is handled by the countdown effect above (idle 15s + burst around cron time)

  // Fetch album art for recent scrobbles
  useEffect(() => {
    if (!ledger?.recent_scrobbles || !creds.lastfm?.api_key) return;
    
    const fetchAlbumArts = async () => {
      const newCache: AlbumArtCache = { ...albumArtCache };
      
      for (const scrobble of ledger.recent_scrobbles.slice(0, 20)) {
        const cacheKey = `${scrobble.artist}|${scrobble.album}`;
        
        // Skip if already in cache
        if (cacheKey in newCache) continue;
        
        const art = await fetchLastfmAlbumArt(
          creds.lastfm?.api_key ?? "",
          scrobble.artist,
          scrobble.album
        );
        newCache[cacheKey] = art;
      }
      
      setAlbumArtCache(newCache);
    };
    
    fetchAlbumArts().catch(console.error);
  }, [ledger?.recent_scrobbles, creds.lastfm?.api_key, albumArtCache]);

  const handleTrigger = async () => {
    if (!workerUrl || !authKey) return;
    setTriggering(true);
    try {
      const res = await triggerScrobble(workerUrl, authKey);
      if (res?.ledger) {
        setLedger(res.ledger);
        setStatusError(null);
      } else {
        await refreshStatus();
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setStatusError(msg);
    } finally {
      setTriggering(false);
    }
  };

  const handleRotate = async () => {
    if (!creds.cloudflare_account_id) return;
    setRotating(true);
    setRotateError(null);
    try {
      await rotateAppleTokens(creds.cloudflare_account_id);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setRotateError(msg);
    } finally {
      setRotating(false);
    }
  };

  const handlePollIntervalChange = async (newInterval: number) => {
    setUpdatingSettings(true);
    try {
      await updatePollInterval(newInterval);
      setSettings({ poll_interval_minutes: newInterval });
      
      const saved = localStorage.getItem("ascrobble_settings") || localStorage.getItem("ascrobble-settings");
      const parsed = saved ? JSON.parse(saved) : {};
      parsed.pollingInterval = newInterval;
      parsed.poll_interval_minutes = newInterval;
      localStorage.setItem("ascrobble_settings", JSON.stringify(parsed));
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setStatusError(`Failed to update settings: ${msg}`);
    } finally {
      setUpdatingSettings(false);
    }
  };

  const handleClearAll = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    try {
      await storageClearAll();
      onReset();
    } catch (e) {
      console.error("clear failed:", e);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateObject) return;
    setInstalling(true);
    try {
      // Clear the sync version so after relaunch we prompt to redeploy worker
      localStorage.removeItem("ascrobble_worker_sync_version");
      await updateObject.downloadAndInstall();
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      setInstalling(false);
    }
  };

  const handleSyncWorker = async () => {
    setSyncingWorker(true);
    try {
      await redeployWorker();
      setWorkerOutOfSync(false);
      setResetToast("Worker synced to v1.1.0 ✓");
      setTimeout(() => setResetToast(null), 4000);
      // Refresh status after redeploy
      setTimeout(refreshStatus, 3000);
    } catch (e) {
      console.error("Worker sync failed:", e);
      const msg = typeof e === "string" ? e : (e as Error).message;
      setStatusError(`Worker sync failed: ${msg}`);
    } finally {
      setSyncingWorker(false);
    }
  };

  const openLastfmProfile = () => {
    if (!creds.lastfm) return;
    open(`https://www.last.fm/user/${creds.lastfm.username}`).catch(console.error);
  };

  const openAppleMusic = () => {
    open("https://music.apple.com").catch(console.error);
  };

  const openCloudflareDashboard = () => {
    if (!creds.cloudflare_account_id) return;
    open(
      `https://dash.cloudflare.com/${creds.cloudflare_account_id}/workers/services/view/ascrobble-scrobbler/production`
    ).catch(console.error);
  };

  const openSubdomainSetup = () => {
    if (!creds.cloudflare_account_id) return;
    open(
      `https://dash.cloudflare.com/${creds.cloudflare_account_id}/workers`
    ).catch(console.error);
  };

  const openLastfmTrack = (scrobble: any) => {
    const artist = encodeURIComponent(scrobble.artist);
    const track = encodeURIComponent(scrobble.track);
    const url = `https://www.last.fm/music/${artist}/_/${track}`;
    open(url).catch(console.error);
  };


  if (loading) {
    return (
      <div className="dashboard">
        <div className="card" style={{ textAlign: "center", padding: 48 }}>
          <div className="spinner" style={{ margin: "0 auto" }} />
          <p className="muted" style={{ marginTop: 16 }}>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const stats = ledger?.stats;
  const circuitOpen = !!(ledger?.circuit_open_until_iso && Date.now() < new Date(ledger.circuit_open_until_iso).getTime());
  
  const statusDot = !ledger
    ? "gray"
    : circuitOpen || statusError
      ? "red"
      : firstRunPending
        ? "yellow"
        : "green";

  return (
    <div className="dashboard">
      {resetToast && (
        <div className="toast">
          {resetToast}
        </div>
      )}
      {/* App update banner */}
      {updateAvailable && (
        <div className="update-banner-floating">
          <div className="update-banner-header">
            <span className="update-banner-badge">🚀 Update ready</span>
            <button className="update-banner-close" onClick={() => setUpdateAvailable(null)} title="Dismiss">
              ✕
            </button>
          </div>
          <div className="update-banner-title">aScrobble v{updateAvailable.version} is available</div>
          <div className="update-banner-desc">
            Installs silently in the background — your scrobbler keeps running. Takes about 10 seconds.
          </div>
          <div className="update-banner-actions">
            <button
              className="btn-update-install"
              onClick={handleInstallUpdate}
              disabled={installing}
            >
              {installing ? "⏳ Installing…" : "⬇ Install & relaunch"}
            </button>
            <button
              className="update-notes-toggle"
              onClick={() => setShowUpdateNotes(v => !v)}
            >
              {showUpdateNotes ? "▲ Hide" : "▼ What's new"}
            </button>
          </div>
          {showUpdateNotes && updateAvailable.body && (
            <div className="update-notes-box">
              {updateAvailable.body
                .replace(/##[^\n]*/g, "")
                .replace(/###\s*/g, "")
                .replace(/\*\*([^*]+)\*\*/g, "$1")
                .replace(/`([^`]+)`/g, "$1")
                .replace(/---[\s\S]*?⚠️.*/, "")
                .trim()
                .split("\n")
                .filter((l: string) => l.trim())
                .map((line: string, i: number) => (
                  <div key={i} style={{ marginBottom: 3 }}>{line.trim()}</div>
                ))
              }
            </div>
          )}
        </div>
      )}

      {/* Worker out-of-sync banner — shown after app update relaunch */}
      {workerOutOfSync && (
        <div className="card" style={{ border: "1px solid rgba(255,200,80,0.4)", background: "rgba(255,200,80,0.05)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <strong style={{ color: "#ffc850" }}>⚡ Worker update available</strong>
              <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.75 }}>
                Your Cloudflare Worker is running an older version. Sync it now to unlock new features like token rotation and cache management.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                className="btn"
                onClick={() => setWorkerOutOfSync(false)}
                style={{ opacity: 0.6, fontSize: 12 }}
              >
                Later
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSyncWorker}
                disabled={syncingWorker}
                style={{ whiteSpace: "nowrap", background: "linear-gradient(135deg, #f59e0b, #d97706)" }}
              >
                {syncingWorker ? "Syncing..." : "Sync Worker"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Panel / Worker Card */}
      <div className="card worker-card" style={{
        background: "linear-gradient(135deg, rgba(20,20,24,0.8) 0%, rgba(10,10,12,0.9) 100%)",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(12px)",
        transition: "transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <span>WORKER</span>
              <select
                value={settings.poll_interval_minutes}
                onChange={(e) => handlePollIntervalChange(Number(e.target.value))}
                disabled={updatingSettings}
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "var(--color-text-secondary)",
                  cursor: "pointer",
                  outline: "none",
                  fontWeight: 500,
                }}
                title="Change polling interval (syncs to Cloudflare live)"
              >
                <option value={1}>1m polling (recommended)</option>
                <option value={2}>2m polling</option>
                <option value={3}>3m polling</option>
                <option value={5}>5m polling</option>
                <option value={10}>10m polling</option>
              </select>
            </div>

            {/* Service Connections List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Last.fm connection */}
              <button
                className="link-btn"
                onClick={openLastfmProfile}
                style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 600 }}
                title="View Last.fm Profile"
              >
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, background: "rgba(213,16,7,0.12)", border: "1px solid rgba(213,16,7,0.2)", flexShrink: 0 }}>
                  <svg width="15" height="15" viewBox="0 0 32 32" fill="#d51007">
                    <path d="M14.43 22.647l-.905-2.462s-1.469 1.641-3.669 1.641c-1.947 0-3.328-1.693-3.328-4.402 0-3.469 1.754-4.712 3.481-4.712 2.485 0 3.276 1.609 3.956 3.672l.905 2.838c.905 2.758 2.611 4.977 7.527 4.977 3.524 0 5.908-1.083 5.908-3.925 0-2.3-1.32-3.487-3.771-4.057l-1.82-.404c-1.263-.282-1.631-.787-1.631-1.628 0-.934.737-1.477 1.943-1.477 1.32 0 2.031.492 2.144 1.669l2.746-.33c-.228-2.477-1.935-3.491-4.745-3.491-2.485 0-4.831.934-4.831 3.925 0 1.87.905 3.051 3.187 3.608l1.935.454c1.462.349 2.087.881 2.087 1.777 0 1.059-.991 1.49-3.048 1.49-2.953 0-4.18-1.546-4.888-3.608l-.934-2.857c-1.206-3.728-3.129-5.103-6.73-5.103-4.066 0-6.27 2.573-6.27 7.074 0 4.308 2.204 6.795 6.099 6.795 3.158 0 4.66-1.46 4.66-1.46z"/>
                  </svg>
                </span>
                <span>{creds.lastfm?.username ?? "last.fm"}</span>
              </button>

              {/* Apple Music connection */}
              <button
                className="link-btn"
                onClick={openAppleMusic}
                style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--color-text-secondary)" }}
                title="Open Apple Music"
              >
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, background: "rgba(252,60,68,0.12)", border: "1px solid rgba(252,60,68,0.2)", flexShrink: 0 }}>
                  <img src="/apple-music.png" alt="Apple Music" style={{ width: 16, height: 16, objectFit: "contain" }} />
                </span>
                <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>Apple Music</span>
              </button>

              {/* Cloudflare Worker connection */}
              <button
                className="link-btn"
                onClick={openCloudflareDashboard}
                style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--color-text-secondary)" }}
                title="Open Cloudflare Worker Dashboard"
              >
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, background: "rgba(243,128,32,0.12)", border: "1px solid rgba(243,128,32,0.2)", flexShrink: 0 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="#f38020">
                    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
                  </svg>
                </span>
                <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>ascrobble-scrobbler</span>
                {creds.cloudflare_account_id && (
                  <span className="meta" style={{ fontSize: 11, opacity: 0.7 }}>
                    ({creds.cloudflare_account_id.slice(0, 8)}…)
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Status Badges & Live Countdown */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 600,
              background: statusDot === "green" ? "rgba(74,222,128,0.1)"
                : statusDot === "yellow" ? "rgba(251,191,36,0.1)"
                : statusDot === "red" ? "rgba(252,60,68,0.1)"
                : "rgba(120,120,120,0.08)",
              color: statusDot === "green" ? "#4ade80"
                : statusDot === "yellow" ? "#fbbf24"
                : statusDot === "red" ? "#fc3c44"
                : "#aaa",
              border: `1px solid ${statusDot === "green" ? "rgba(74,222,128,0.25)"
                : statusDot === "yellow" ? "rgba(251,191,36,0.25)"
                : statusDot === "red" ? "rgba(252,60,68,0.25)"
                : "rgba(120,120,120,0.15)"}`,
              boxShadow: statusDot === "green" ? "0 0 12px rgba(74,222,128,0.15)" : "none",
            }}>
              <div style={{
                width: 7, height: 7, borderRadius: "50%", background: "currentColor", flexShrink: 0,
                boxShadow: statusDot === "green" ? "0 0 6px currentColor" : "none",
              }} />
              {statusDot === "green"
                ? (ledger?.last_run_iso ? `Active · ${relativeTime(ledger.last_run_iso)}` : "Active")
                : statusDot === "yellow" ? "Pending"
                : statusDot === "red" ? "Connection Error"
                : "No data"}
            </div>

            {/* Countdown Badge */}
            {countdownSec !== null && statusDot !== "red" && statusDot !== "gray" && (
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 4 }}>
                <span>⏳ Next check in</span>
                <strong style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
                  {countdownSec <= 0 ? "Polling..." : formatCountdown(countdownSec)}
                </strong>
              </div>
            )}
          </div>
        </div>

        {/* Stats Row with Clear Error Log Button */}
        {stats && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{
                padding: "4px 12px", borderRadius: 8,
                background: "rgba(252,60,68,0.08)", border: "1px solid rgba(252,60,68,0.18)",
                fontSize: 12, color: "var(--color-text-secondary)",
              }}>
                <span style={{ color: "#fc3c44", fontWeight: 700 }}>{stats.total_scrobbled.toLocaleString()}</span>
                {" "}scrobbled
              </div>
              <div style={{
                padding: "4px 12px", borderRadius: 8,
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                fontSize: 12, color: "var(--color-text-tertiary)",
              }}>
                {stats.total_runs.toLocaleString()} polls
              </div>
              {stats.total_errors > 0 && (
                <div style={{
                  padding: "4px 12px", borderRadius: 8,
                  background: "rgba(252,60,68,0.06)", border: "1px solid rgba(252,60,68,0.18)",
                  fontSize: 12, color: "#fc3c44",
                }}>
                  {stats.total_errors.toLocaleString()} errors
                </div>
              )}
            </div>

            {stats.total_errors > 0 && (
              <button
                className="link-btn"
                onClick={handleResetStats}
                style={{ fontSize: 11, opacity: 0.7, textDecoration: "underline", color: "#fc3c44" }}
                title="Reset total error counters and clear error log"
              >
                Clear error log
              </button>
            )}
          </div>
        )}

        {firstRunPending && !ledger?.last_run_iso && (
          <div className="status" style={{ marginTop: 12, background: "rgba(251,191,36,0.07)", borderColor: "rgba(251,191,36,0.2)" }}>
            <span className="status-icon" style={{ color: "#fbbf24" }}>◐</span>
            <div style={{ color: "#fbbf24" }}>
              <strong>Waiting for first poll</strong>
              <p style={{ margin: "6px 0 0", fontSize: "0.9em", opacity: 0.85 }}>
                Worker deployed successfully. The first scrobble check will run within 1 minute.
                Play some music in Apple Music and it will appear here automatically.
              </p>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 10, fontSize: 12 }}
                onClick={handleTrigger}
                disabled={triggering}
              >
                {triggering ? "Running..." : "Run now instead"}
              </button>
            </div>
          </div>
        )}
        {statusError && !firstRunPending && (
          <div className="status status-error" style={{ marginTop: 12 }}>
            <span className="status-icon">!</span>
            <div>
              <strong>Failed to fetch worker status</strong>
              <p style={{ margin: "6px 0 0", fontSize: "0.9em", opacity: 0.8 }}>
                {statusError.includes("401") || statusError.includes("Unauthorized")
                  ? "The worker may not be fully deployed. Try redeploying."
                  : statusError.includes("Failed to fetch")
                  ? "The worker URL may not be accessible. Make sure your workers.dev subdomain is configured."
                  : statusError}
              </p>
            </div>
          </div>
        )}
        {subdomainMissing && (
          <div className="status status-error" style={{ marginTop: 12 }}>
            <span className="status-icon">!</span>
            <div>
              No workers.dev subdomain found.{" "}
              <button className="link-btn" onClick={openSubdomainSetup}>Set one up</button>
              {" "}to enable live status.
            </div>
          </div>
        )}

        {/* Verbose Worker Log */}
        {ledger && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button
                onClick={() => setShowWorkerLog(v => !v)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  color: "var(--color-text-tertiary)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: 0,
                  opacity: 0.7,
                }}
              >
                <span style={{ fontSize: 9 }}>{showWorkerLog ? "▼" : "▶"}</span>
                Worker Log {ledger.log_entries?.length ? `(${ledger.log_entries.length} entries)` : "(no entries yet)"}
              </button>
              {!ledger.log_entries?.length && (
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 10, padding: "2px 8px", height: "auto" }}
                  onClick={handleTrigger}
                  disabled={triggering}
                >
                  {triggering ? "Running..." : "Run now to populate"}
                </button>
              )}
            </div>
            {showWorkerLog && (
              <div style={{
                marginTop: 8,
                background: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 10,
                padding: "10px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                maxHeight: 280,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}>
                {!ledger.log_entries?.length ? (
                  <div style={{ color: "var(--color-text-tertiary)", fontStyle: "italic", textAlign: "center", padding: "16px 0" }}>
                    No log entries yet — click "Run now to populate" or wait for next cron poll (~1 min)
                  </div>
                ) : ledger.log_entries.map((entry: LogEntry, i: number) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.5 }}>
                    <span style={{
                      flexShrink: 0,
                      color: "var(--color-text-tertiary)",
                      fontSize: 10,
                      minWidth: 68,
                      paddingTop: 1,
                    }}>
                      {new Date(entry.timestamp_iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span style={{
                      flexShrink: 0,
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: 4,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: entry.level === "error" ? "#fc3c44"
                        : entry.level === "warn" ? "#fbbf24"
                        : entry.level === "success" ? "#4ade80"
                        : "#60a5fa",
                      background: entry.level === "error" ? "rgba(252,60,68,0.12)"
                        : entry.level === "warn" ? "rgba(251,191,36,0.12)"
                        : entry.level === "success" ? "rgba(74,222,128,0.12)"
                        : "rgba(96,165,250,0.12)",
                      border: `1px solid ${entry.level === "error" ? "rgba(252,60,68,0.2)"
                        : entry.level === "warn" ? "rgba(251,191,36,0.2)"
                        : entry.level === "success" ? "rgba(74,222,128,0.2)"
                        : "rgba(96,165,250,0.2)"}`,
                      alignSelf: "flex-start",
                      marginTop: 2,
                    }}>
                      {entry.level ?? "info"}
                    </span>
                    <div style={{ color: "var(--color-text-secondary)" }}>
                      <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{entry.step}</span>
                      {entry.details && (
                        <span style={{ opacity: 0.7, marginLeft: 6 }}>{entry.details}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recent Scrobbles */}
      <div className="card scrobbles-card">
        <div className="scrobbles-header">
          <h2>Recently scrobbled</h2>
          {ledger && ledger.recent_scrobbles.length > 0 && (
            <span className="scrobbles-count">{ledger.recent_scrobbles.length} tracks</span>
          )}
        </div>
        
        {!ledger || ledger.recent_scrobbles.length === 0 ? (
          <div className="scrobbles-empty">
            <div className="scrobbles-empty-icon">🎵</div>
            <p>No scrobbles yet</p>
            <p className="scrobbles-empty-hint">Play some music and check back in a few minutes</p>
          </div>
        ) : (
          <div className="scrobble-list">
            {[...ledger.recent_scrobbles]
              .sort((a, b) => new Date(b.timestamp_iso).getTime() - new Date(a.timestamp_iso).getTime())
              .slice(0, 10)
              .map((s, i) => {
              const cacheKey = `${s.artist}|${s.album}`;
              const albumArt = albumArtCache[cacheKey];
              const isLatest = i === 0;
              
              return (
                <div
                  key={i}
                  className={`scrobble-row ${isLatest ? 'scrobble-row--latest' : ''}`}
                  onClick={() => openLastfmTrack(s)}
                >
                  <div className="scrobble-row-number">{i + 1}</div>
                  
                  <div className="scrobble-row-art">
                    {albumArt ? (
                      <img src={albumArt} alt={s.album} loading="lazy" />
                    ) : (
                      <div className="scrobble-row-art-placeholder">
                        <span>♪</span>
                      </div>
                    )}
                    {isLatest && <div className="scrobble-now-playing" />}
                  </div>

                  <div className="scrobble-row-info">
                    <div className="scrobble-row-track" title={s.track}>
                      {s.track}
                    </div>
                    <div className="scrobble-row-meta">
                      <span className="scrobble-row-artist" title={s.artist}>{s.artist}</span>
                      <span className="scrobble-row-separator">•</span>
                      <span className="scrobble-row-album" title={s.album}>{s.album}</span>
                    </div>
                  </div>

                  <div className="scrobble-row-right">
                    {s.kind === 'repeat' && <span className="scrobble-badge">↻</span>}
                    <span className="scrobble-row-time">{relativeTime(s.timestamp_iso)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        
        {/* View All button when 10+ scrobbles - sorted by most recent */}
        {ledger && ledger.recent_scrobbles.length >= 10 && (
          <div className="actions" style={{ marginTop: 'var(--space-lg)', justifyContent: 'center' }}>
            <button 
              className="btn btn-secondary" 
              onClick={() => setShowAllScrobbles(true)}
            >
              View All {ledger.recent_scrobbles.length} Scrobbles →
            </button>
          </div>
        )}
      </div>

      {/* Scrobbles Modal */}
      {showAllScrobbles && ledger && (
        <ScrobblesModal
          scrobbles={ledger.recent_scrobbles}
          albumArtCache={albumArtCache}
          onClose={() => setShowAllScrobbles(false)}
          onTrackClick={openLastfmTrack}
        />
      )}

      {/* Token Expiry Card */}
      {creds.apple && (() => {
        const days = daysUntilExpiry(creds.apple.captured_at, decodedAppleExpiry);
        const expiring = days < 30;
        return (
          <div className="card" style={expiring ? { border: "1px solid rgba(251,191,36,0.4)" } : undefined}>
            <h2>Apple tokens</h2>
            {expiring && (
              <div className="status status-error" style={{ marginBottom: 12, background: "rgba(251,191,36,0.1)", borderColor: "rgba(251,191,36,0.3)" }}>
                <span className="status-icon" style={{ color: "#fbbf24" }}>!</span>
                <div style={{ color: "#fbbf24" }}>
                  <strong>Tokens expire in {days} day{days !== 1 ? "s" : ""}</strong>
                  <p style={{ margin: "4px 0 0", fontSize: "0.85em", opacity: 0.85 }}>
                    Rotate now to avoid scrobbling interruptions.
                  </p>
                </div>
              </div>
            )}
            <div className="summary" style={{ margin: "12px 0" }}>
              <div className="summary-row">
                <span className="summary-label">Captured</span>
                <span>{new Date(creds.apple.captured_at).toLocaleDateString()}</span>
              </div>
              <div className="summary-row">
                <span className="summary-label">
                  {decodedAppleExpiry ? "Token expires" : "Estimated expiry"}
                </span>
                <span style={{ color: expiring ? "#fbbf24" : undefined }}>
                  {daysUntilExpiry(creds.apple.captured_at, decodedAppleExpiry)} days remaining
                  {decodedAppleExpiry && (
                    <span className="meta" style={{ marginLeft: 8, fontSize: 12 }}>
                      (from JWT)
                    </span>
                  )}
                </span>
              </div>
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn-secondary"
                onClick={handleRotate}
                disabled={rotating}
              >
                {rotating ? "Rotating..." : "Rotate now"}
              </button>
            </div>
            {rotateError && (
              <div className="status status-error" style={{ marginTop: 12 }}>
                <span className="status-icon">!</span>
                <div>{rotateError}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Settings Card */}
      <div className="card">
        <h2>Settings</h2>
        <div className="summary" style={{ margin: "12px 0" }}>
          <div className="summary-row">
            <span className="summary-label">Polling interval</span>
            <select
              value={settings.poll_interval_minutes}
              onChange={(e) => handlePollIntervalChange(parseInt(e.target.value))}
              disabled={updatingSettings}
              style={{
                padding: "6px 12px",
                borderRadius: 4,
                border: "1px solid #2a2a2d",
                background: "#0a0a0a",
                color: "#fff",
                cursor: "pointer",
                fontSize: 14,
                fontFamily: "inherit",
              }}
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Changes are saved immediately. The worker will use the new interval on next deployment or restart.
        </p>
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handleTrigger}
            disabled={triggering || !workerUrl || !authKey}
          >
            {triggering ? "Triggering..." : "Trigger scrobble now"}
          </button>
          <button className="btn btn-secondary" onClick={refreshStatus} disabled={!workerUrl || !authKey}>
            Refresh
          </button>
        </div>
      </div>

      {/* Service Connections */}
      <div className="card">
        <h2>Connections</h2>
        <div className="checklist">
          <div className="check-row ok">
            <span className="check-icon">OK</span>
            <span style={{ flex: 1 }}>Apple Music</span>
            <span className="muted">
              captured {creds.apple ? new Date(creds.apple.captured_at).toLocaleDateString() : "?"}
            </span>
          </div>
          <div className="check-row ok">
            <span className="check-icon">OK</span>
            <span style={{ flex: 1 }}>Last.fm ({creds.lastfm?.username ?? "?"})</span>
          </div>
          <div className="check-row ok">
            <span className="check-icon">OK</span>
            <span style={{ flex: 1 }}>Cloudflare ({creds.cloudflare_account_id?.slice(0, 8) ?? "?"}...)</span>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onReset}>
            Reconfigure
          </button>
          <button
            className={`btn ${confirmReset ? "btn-danger" : "btn-secondary"}`}
            onClick={handleClearAll}
          >
            {confirmReset ? "Confirm: clear all" : "Clear credentials"}
          </button>
        </div>
        {confirmReset && (
          <p className="hint">
            This removes all stored credentials. The deployed worker keeps running
            until you delete it from your Cloudflare dashboard.
          </p>
        )}
      </div>
    </div>
  );
}
