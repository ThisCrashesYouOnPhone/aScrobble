import { useEffect, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { StoredCredentials, WorkerLedger, UserSettings } from "../types";
import {
  getWorkerUrl,
  getStatusAuthKey,
  rotateAppleTokens,
  loadUserSettings,
  storageClearAll,
  saveUserSettings,
  appleDecodeTokenExpiry,
} from "../lib/tauri";
import { fetchStatus, triggerScrobble, fetchLastfmAlbumArt } from "../lib/worker-api";

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

function daysUntilExpiry(capturedAt: string, actualExpiry?: string | null): number {
  let expiresAt: number;
  
  if (actualExpiry) {
    // Use the actual decoded JWT expiry
    expiresAt = new Date(actualExpiry).getTime();
  } else {
    // Fall back to 180-day estimate
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
  const [settings, setSettings] = useState<UserSettings>({ poll_interval_minutes: 5 });
  const [confirmReset, setConfirmReset] = useState(false);
  const [subdomainMissing, setSubdomainMissing] = useState(false);
  const [albumArtCache, setAlbumArtCache] = useState<AlbumArtCache>({});
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [showAllScrobbles, setShowAllScrobbles] = useState(false);
  const [decodedAppleExpiry, setDecodedAppleExpiry] = useState<string | null>(creds.apple?.expires_at || null);

  // Notify parent of status changes
  useEffect(() => {
    if (!onStatusChange) return;
    
    const stats = ledger?.stats;
    let color = "gray";
    let text = "Unknown";
    
    if (!ledger) {
      color = "gray";
      text = "No data";
    } else if (stats?.last_error_message) {
      color = "red";
      text = "Error";
    } else if (ledger.last_run_iso && Date.now() - new Date(ledger.last_run_iso).getTime() < (settings.poll_interval_minutes + 2) * 60_000) {
      color = "green";
      text = "Running";
    } else {
      color = "yellow";
      text = "Stale";
    }
    
    onStatusChange({ color, text });
  }, [ledger, settings.poll_interval_minutes, onStatusChange]);

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
          const data = await fetchStatus(url, key);
          setLedger(data);
          setStatusError(null);
        }
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

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!workerUrl || !authKey) return;
    const interval = setInterval(refreshStatus, 30_000);
    return () => clearInterval(interval);
  }, [workerUrl, authKey, refreshStatus]);

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
      await triggerScrobble(workerUrl, authKey);
      // Wait briefly then refresh to show new data
      setTimeout(refreshStatus, 3000);
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
      // Save the new setting
      await saveUserSettings({ poll_interval_minutes: newInterval });
      setSettings({ poll_interval_minutes: newInterval });
      
      // Note: Actual redeploy would require calling deploy_worker again
      // For now we just save the setting and show a note that redeploy is needed
      console.log("Poll interval updated to", newInterval, "minutes");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      console.error("Failed to update poll interval:", msg);
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

  const openLastfmProfile = () => {
    if (!creds.lastfm) return;
    open(`https://www.last.fm/user/${creds.lastfm.username}`).catch(console.error);
  };

  const openCloudflareDashboard = () => {
    if (!creds.cloudflare_account_id) return;
    open(
      `https://dash.cloudflare.com/${creds.cloudflare_account_id}/workers/services/view/amusic-scrobbler/production`
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
  const statusDot = !ledger
    ? "gray"
    : stats?.last_error_message
      ? "red"
      : ledger.last_run_iso && Date.now() - new Date(ledger.last_run_iso).getTime() < (settings.poll_interval_minutes + 2) * 60_000
        ? "green"
        : "yellow";

  return (
    <div className="dashboard">
      {/* Status Panel */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>amusic-scrobbler</h1>
          <div style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: statusDot === "green"
              ? "#4ade80"
              : statusDot === "yellow"
              ? "#fbbf24"
              : statusDot === "red"
              ? "#fc3c44"
              : "#666",
            boxShadow: statusDot === "green" ? "0 0 8px rgba(74, 222, 128, 0.5)" : undefined,
          }} />
        </div>
        
        <div className="summary">
          <div className="summary-row">
            <span className="summary-label">Scrobbling to</span>
            <button className="link-btn" onClick={openLastfmProfile}>
              last.fm/{creds.lastfm?.username ?? "?"}
            </button>
          </div>
          <div className="summary-row">
            <span className="summary-label">Last run</span>
            <span style={{ fontFamily: "monospace", fontSize: 12 }}>
              {ledger?.last_run_iso ? relativeTime(ledger.last_run_iso) : "never"}
            </span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Status</span>
            <span style={{
              color: stats?.last_error_message ? "#fc3c44" : "#4ade80",
              fontWeight: 500,
            }}>
              {stats?.last_error_message ? (
                <>
                  <span style={{ fontSize: 12 }}>Error: </span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{stats.last_error_message.substring(0, 50)}</span>
                </>
              ) : (
                "OK"
              )}
            </span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Worker</span>
            <button className="link-btn" onClick={openCloudflareDashboard}>
              Cloudflare dashboard
            </button>
          </div>
        </div>
        
        {statusError && (
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
              No workers.dev subdomain found. The dashboard needs a workers.dev subdomain to fetch live status.{" "}
              <button className="link-btn" onClick={openSubdomainSetup}>
                Set up your subdomain
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Stats Panel */}
      {stats && (
        <div className="card" style={{ background: "linear-gradient(135deg, rgba(42,138,61,0.1) 0%, rgba(50,50,55,0.1) 100%)" }}>
          <h2 style={{ marginTop: 0, marginBottom: 20 }}>Statistics</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
            <div style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(252, 60, 68, 0.1)",
              border: "1px solid rgba(252, 60, 68, 0.2)",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#fc3c44", marginBottom: 8 }}>
                {stats.total_scrobbled.toLocaleString()}
              </div>
              <div style={{ fontSize: 12, color: "#999" }}>Total scrobbled</div>
            </div>
            
            <div style={{
              padding: 16,
              borderRadius: 8,
              background: "rgba(100, 200, 255, 0.1)",
              border: "1px solid rgba(100, 200, 255, 0.2)",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#64c8ff", marginBottom: 8 }}>
                {stats.total_runs.toLocaleString()}
              </div>
              <div style={{ fontSize: 12, color: "#999" }}>Total runs</div>
            </div>
            
            <div style={{
              padding: 16,
              borderRadius: 8,
              background: stats.total_errors > 0 ? "rgba(204, 51, 51, 0.1)" : "rgba(74, 222, 128, 0.1)",
              border: stats.total_errors > 0 ? "1px solid rgba(204, 51, 51, 0.2)" : "1px solid rgba(74, 222, 128, 0.2)",
              textAlign: "center",
            }}>
              <div style={{
                fontSize: 32,
                fontWeight: 700,
                color: stats.total_errors > 0 ? "#c33" : "#4ade80",
                marginBottom: 8,
              }}>
                {stats.total_errors}
              </div>
              <div style={{ fontSize: 12, color: "#999" }}>Errors</div>
            </div>
          </div>
        </div>
      )}

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
      {creds.apple && (
        <div className="card">
          <h2>Apple tokens</h2>
          <div className="summary" style={{ margin: "12px 0" }}>
            <div className="summary-row">
              <span className="summary-label">Captured</span>
              <span>{new Date(creds.apple.captured_at).toLocaleDateString()}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">
                {decodedAppleExpiry ? "Token expires" : "Estimated expiry"}
              </span>
              <span>
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
      )}

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
