import { useEffect, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { StoredCredentials, WorkerLedger, UserSettings } from "../types";
import {
  getWorkerUrl,
  getStatusAuthKey,
  rotateAppleTokens,
  loadUserSettings,
  storageClearAll,
} from "../lib/tauri";
import { fetchStatus, triggerScrobble } from "../lib/worker-api";

interface DashboardProps {
  creds: StoredCredentials;
  onReset: () => void;
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

function daysUntilExpiry(capturedAt: string): number {
  const captured = new Date(capturedAt).getTime();
  const expiresAt = captured + 180 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function Dashboard({ creds, onReset }: DashboardProps) {
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
        if (!url) {
          setSubdomainMissing(true);
          setLoading(false);
          return;
        }
        if (url && key) {
          const data = await fetchStatus(url, key);
          setLedger(data);
        }
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error).message;
        setStatusError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!workerUrl || !authKey) return;
    const interval = setInterval(refreshStatus, 30_000);
    return () => clearInterval(interval);
  }, [workerUrl, authKey, refreshStatus]);

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>amusic-scrobbler</h2>
          <div style={{
            width: 12, height: 12, borderRadius: "50%",
            background: statusDot === "green" ? "#2a8a3d" : statusDot === "yellow" ? "#e6a700" : statusDot === "red" ? "#c33" : "#555",
          }} />
        </div>
        <div className="summary" style={{ margin: "16px 0 0" }}>
          <div className="summary-row">
            <span className="summary-label">Scrobbling to</span>
            <button className="link-btn" onClick={openLastfmProfile}>
              last.fm/{creds.lastfm?.username ?? "?"}
            </button>
          </div>
          <div className="summary-row">
            <span className="summary-label">Last run</span>
            <span>{ledger?.last_run_iso ? relativeTime(ledger.last_run_iso) : "never"}</span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Status</span>
            <span>{stats?.last_error_message ?? "ok"}</span>
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
            <div>{statusError}</div>
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
        <div className="card">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 120, textAlign: "center" }}>
              <div style={{ fontSize: 36, fontWeight: 700, color: "#fc3c44" }}>
                {stats.total_scrobbled.toLocaleString()}
              </div>
              <div className="muted">total scrobbled</div>
            </div>
            <div style={{ flex: 1, minWidth: 120, textAlign: "center" }}>
              <div style={{ fontSize: 36, fontWeight: 700 }}>
                {stats.total_runs.toLocaleString()}
              </div>
              <div className="muted">total runs</div>
            </div>
            <div style={{ flex: 1, minWidth: 120, textAlign: "center" }}>
              <div style={{ fontSize: 36, fontWeight: 700, color: stats.total_errors > 0 ? "#c33" : undefined }}>
                {stats.total_errors}
              </div>
              <div className="muted">errors</div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Scrobbles */}
      {ledger && ledger.recent_scrobbles.length > 0 && (
        <div className="card">
          <h2>Recent scrobbles</h2>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {ledger.recent_scrobbles.slice(0, 20).map((s, i) => (
              <div key={i} className="summary-row" style={{ borderBottom: "1px solid #2a2a2d", padding: "8px 0" }}>
                <div>
                  <strong>{s.track}</strong>
                  <div className="muted">{s.artist}{s.album ? ` \u2014 ${s.album}` : ""}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <span className="muted">{relativeTime(s.timestamp_iso)}</span>
                  <div>
                    <span style={{
                      display: "inline-block",
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: s.kind === "new" ? "rgba(42,138,61,0.2)" : "rgba(230,167,0,0.2)",
                      color: s.kind === "new" ? "#4ade80" : "#fbbf24",
                    }}>{s.kind}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
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
              <span className="summary-label">Estimated expiry</span>
              <span>{daysUntilExpiry(creds.apple.captured_at)} days remaining</span>
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
            <span>{INTERVAL_OPTIONS.find((o) => o.value === settings.poll_interval_minutes)?.label ?? `${settings.poll_interval_minutes} min`}</span>
          </div>
        </div>
        <p className="muted">Changing the interval requires a redeploy.</p>
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
