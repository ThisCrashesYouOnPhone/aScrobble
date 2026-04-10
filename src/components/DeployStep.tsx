import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import type { StoredCredentials } from "../types";
import { deployWorker, storageGetAll, loadUserSettings, saveUserSettings } from "../lib/tauri";

const INTERVAL_OPTIONS = [
  { value: 1, label: "1 minute (most responsive, more API calls)" },
  { value: 2, label: "2 minutes" },
  { value: 5, label: "5 minutes (recommended)" },
  { value: 10, label: "10 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
] as const;

interface DeployStepProps {
  creds: StoredCredentials;
  onComplete: () => void;
  onBack: () => void;
}

interface ProgressEvent {
  step: number;
  total: number;
  label: string;
}

type Phase = "ready" | "deploying" | "success" | "error";

export function DeployStep({ creds, onComplete, onBack }: DeployStepProps) {
  const normalizeCreds = (value: unknown): StoredCredentials => {
    const input = (value ?? {}) as Record<string, unknown>;
    const cloudflareObj =
      (input.cloudflare as Record<string, unknown> | undefined) ?? {};

    return {
      apple:
        (input.apple as StoredCredentials["apple"] | undefined) ??
        (input.appleTokens as StoredCredentials["apple"] | undefined) ??
        null,
      lastfm:
        (input.lastfm as StoredCredentials["lastfm"] | undefined) ??
        (input.lastFm as StoredCredentials["lastfm"] | undefined) ??
        null,
      cloudflare_oauth:
        (input.cloudflare_oauth as StoredCredentials["cloudflare_oauth"] | undefined) ??
        (input.cloudflareOauth as StoredCredentials["cloudflare_oauth"] | undefined) ??
        (cloudflareObj.oauth as StoredCredentials["cloudflare_oauth"] | undefined) ??
        null,
      cloudflare_token:
        (input.cloudflare_token as string | null | undefined) ??
        (input.cloudflareToken as string | null | undefined) ??
        (cloudflareObj.token as string | null | undefined) ??
        null,
      cloudflare_account_id:
        (input.cloudflare_account_id as string | null | undefined) ??
        (input.cloudflareAccountId as string | null | undefined) ??
        (cloudflareObj.account_id as string | null | undefined) ??
        (cloudflareObj.accountId as string | null | undefined) ??
        null,
    };
  };

  const [effectiveCreds, setEffectiveCreds] = useState<StoredCredentials>(
    normalizeCreds(creds)
  );
  const [phase, setPhase] = useState<Phase>("ready");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workerName, setWorkerName] = useState<string | null>(null);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [pollInterval, setPollInterval] = useState(5);
  const [listenbrainzToken, setListenbrainzToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const refreshFromStorage = async () => {
    try {
      const next = await storageGetAll();
      setEffectiveCreds(normalizeCreds(next));
      setSyncInfo("Re-checked credentials from keychain.");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setSyncInfo(`Credential re-check failed: ${msg ?? "unknown error"}`);
    }
  };

  useEffect(() => {
    setEffectiveCreds(normalizeCreds(creds));
  }, [creds]);

  useEffect(() => {
    void refreshFromStorage();
    loadUserSettings()
      .then((s) => setPollInterval(s.poll_interval_minutes))
      .catch(() => {}); // use default 5 if never saved
  }, []);

  // Listen for live progress events from the Rust deploy module
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ProgressEvent>("deploy-progress", (event) => {
      setProgress(event.payload);
      setHistory((h) => [...h, event.payload.label]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleDeploy = async () => {
    if (!effectiveCreds.cloudflare_account_id) {
      setError("No Cloudflare account selected");
      return;
    }
    setPhase("deploying");
    setError(null);
    setHistory([]);
    setProgress(null);
    try {
      await saveUserSettings({ poll_interval_minutes: pollInterval });
      const result = await deployWorker(
        effectiveCreds.cloudflare_account_id,
        pollInterval,
        listenbrainzToken.trim() || undefined,
        webhookUrl.trim() || undefined,
      );
      setWorkerName(result);
      setPhase("success");
      // Brief pause so the user sees the success state
      setTimeout(onComplete, 1500);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setError(msg ?? "Deployment failed");
      setPhase("error");
    }
  };

  const allReady =
    effectiveCreds.apple &&
    effectiveCreds.lastfm &&
    (effectiveCreds.cloudflare_oauth || effectiveCreds.cloudflare_token) &&
    effectiveCreds.cloudflare_account_id;

  return (
    <div className="step-page card">
      <h2>Deploy to Cloudflare</h2>
      <p className="lead">
        Everything is ready. Pressing Deploy will create a KV namespace,
        upload the scrobbler worker, set up secrets, seed your Apple tokens,
        and configure a cron trigger - all on your own Cloudflare account.
      </p>

      <div className="form">
        <div className="form-row">
          <label>
            <span>Polling interval</span>
            <select
              value={pollInterval}
              onChange={(e) => setPollInterval(Number(e.target.value))}
              disabled={phase !== "ready"}
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            <span>
              ListenBrainz token{" "}
              <span style={{ fontWeight: 400, opacity: 0.6, fontSize: "0.85em" }}>(optional)</span>
            </span>
            <input
              type="password"
              placeholder="Paste your ListenBrainz user token"
              value={listenbrainzToken}
              onChange={(e) => setListenbrainzToken(e.target.value)}
              disabled={phase !== "ready"}
              style={{ fontFamily: "monospace", fontSize: 13 }}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            <span>
              Discord / Slack webhook{" "}
              <span style={{ fontWeight: 400, opacity: 0.6, fontSize: "0.85em" }}>(optional)</span>
            </span>
            <input
              type="url"
              placeholder="https://discord.com/api/webhooks/..."
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              disabled={phase !== "ready"}
              style={{ fontFamily: "monospace", fontSize: 13 }}
            />
          </label>
        </div>
      </div>

      <div className="checklist">
        <div className={`check-row ${effectiveCreds.apple ? "ok" : "missing"}`}>
          <span className="check-icon">{effectiveCreds.apple ? "OK" : "X"}</span>
          <span>Apple Music tokens</span>
        </div>
        <div className={`check-row ${effectiveCreds.lastfm ? "ok" : "missing"}`}>
          <span className="check-icon">{effectiveCreds.lastfm ? "OK" : "X"}</span>
          <span>
            Last.fm session
            {effectiveCreds.lastfm ? ` (${effectiveCreds.lastfm.username})` : ""}
          </span>
        </div>
        <div
          className={`check-row ${
            (effectiveCreds.cloudflare_oauth || effectiveCreds.cloudflare_token) &&
            effectiveCreds.cloudflare_account_id
              ? "ok"
              : "missing"
          }`}
        >
          <span className="check-icon">
            {(effectiveCreds.cloudflare_oauth || effectiveCreds.cloudflare_token) &&
            effectiveCreds.cloudflare_account_id
              ? "OK"
              : "X"}
          </span>
          <span>
            Cloudflare account
            {effectiveCreds.cloudflare_account_id
              ? ` (${effectiveCreds.cloudflare_account_id.slice(0, 8)}...)`
              : ""}
          </span>
        </div>
      </div>

      {syncInfo && (
        <div className="status">
          <div>{syncInfo}</div>
        </div>
      )}

      <details className="how-it-works">
        <summary>Debug credential state</summary>
        <p>Apple: {effectiveCreds.apple ? "present" : "missing"}</p>
        <p>Last.fm: {effectiveCreds.lastfm ? "present" : "missing"}</p>
        <p>
          Cloudflare OAuth:{" "}
          {effectiveCreds.cloudflare_oauth ? "present" : "missing"}
        </p>
        <p>
          Cloudflare token:{" "}
          {effectiveCreds.cloudflare_token
            ? `present (${effectiveCreds.cloudflare_token.length} chars)`
            : "missing"}
        </p>
        <p>
          Cloudflare account:{" "}
          {effectiveCreds.cloudflare_account_id
            ? `present (${effectiveCreds.cloudflare_account_id.slice(0, 8)}...)`
            : "missing"}
        </p>
      </details>

      {phase === "deploying" && (
        <div className="deploy-progress">
          {progress && (
            <>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(progress.step / progress.total) * 100}%` }}
                />
              </div>
              <div className="progress-label">
                <span>{progress.label}</span>
                <span className="meta">
                  {progress.step} / {progress.total}
                </span>
              </div>
            </>
          )}
          <div className="log">
            {history.map((line, i) => (
              <div key={i} className="log-line">
                <span className="log-mark">-&gt;</span> {line}
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === "success" && workerName && (
        <div className="status status-ok">
          <span className="status-icon">OK</span>
          <div>
            <strong>Deployed</strong>
            <div className="meta">Worker name: {workerName}</div>
            <div className="meta" style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              If the dashboard shows "Failed to fetch", make sure you have set up a workers.dev subdomain.
              Visit your{" "}
              <a
                href="#"
                onClick={() => open(`https://dash.cloudflare.com/${effectiveCreds.cloudflare_account_id}/workers`).catch(console.error)}
                style={{ color: "inherit", textDecoration: "underline" }}
              >
                Cloudflare Workers settings
              </a>{" "}
              to enable it.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="status status-error">
          <span className="status-icon">!</span>
          <div>{error}</div>
        </div>
      )}

      <div className="actions">
        <button className="btn" onClick={onBack} disabled={phase === "deploying"}>
          &lt;- Back
        </button>
        {phase === "ready" && (
          <button className="btn btn-secondary" onClick={refreshFromStorage}>
            Re-check credentials
          </button>
        )}
        {phase === "ready" && (
          <button
            className="btn btn-primary btn-large"
            onClick={handleDeploy}
            disabled={!allReady}
          >
            Deploy to Cloudflare
          </button>
        )}
        {phase === "deploying" && (
          <button className="btn btn-primary" disabled>
            Deploying...
          </button>
        )}
        {phase === "error" && (
          <button className="btn btn-primary" onClick={handleDeploy}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
