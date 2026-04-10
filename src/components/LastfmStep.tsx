import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { LastfmSession } from "../types";
import { lastfmStartAuth, lastfmCancelAuth } from "../lib/tauri";

interface LastfmStepProps {
  existing: LastfmSession | null;
  onComplete: () => void;
  onBack: () => void;
}

export function LastfmStep({ existing, onComplete, onBack }: LastfmStepProps) {
  const [apiKey, setApiKey] = useState(existing?.api_key ?? "");
  const [sharedSecret, setSharedSecret] = useState(existing?.shared_secret ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = apiKey.trim().length > 0 && sharedSecret.trim().length > 0;

  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await lastfmStartAuth(apiKey.trim(), sharedSecret.trim());
      onComplete();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setError(msg ?? "Last.fm sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    try {
      await lastfmCancelAuth();
    } catch {
      // best effort
    }
    setBusy(false);
  };

  const openCreateApp = () => {
    open("https://www.last.fm/api/account/create").catch(console.error);
  };

  return (
    <div className="step-page card">
      <h2>Connect Last.fm</h2>
      <p className="lead">
        aScrobble needs an API key and shared secret from Last.fm. These come from
        creating a (free, instant) API application on your Last.fm account.
      </p>

      {existing && (
        <div className="status status-ok">
          <span className="status-icon">✓</span>
          <div>
            <strong>Last.fm is connected as {existing.username}</strong>
            <div className="meta">Session key never expires unless revoked.</div>
          </div>
        </div>
      )}

      <div className="form">
        <div className="form-row">
          <label>
            <div className="label-row">
              <span>API key</span>
              <button className="link-btn" onClick={openCreateApp}>
                Get one →
              </button>
            </div>
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="32 character hex string"
              disabled={busy}
            />
          </label>
        </div>

        <div className="form-row">
          <label>
            <span>Shared secret</span>
            <input
              type="password"
              spellCheck={false}
              autoComplete="off"
              value={sharedSecret}
              onChange={(e) => setSharedSecret(e.target.value)}
              placeholder="32 character hex string"
              disabled={busy}
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="status status-error">
          <span className="status-icon">!</span>
          <div>{error}</div>
        </div>
      )}

      <details className="how-it-works">
        <summary>How does this work?</summary>
        <p>
          When you click Connect, aScrobble opens{" "}
          <code>https://www.last.fm/api/auth</code> in your browser. You click
          "Yes, allow access" and Last.fm redirects to a temporary HTTP server
          running on your local machine (RFC 8252 native-app loopback flow).
          aScrobble catches the redirect, exchanges the temporary token for a
          permanent session key via <code>auth.getSession</code>, and stores
          it in your operating system keychain.
        </p>
        <p>
          The session key never expires unless you revoke it at{" "}
          <code>last.fm/settings/applications</code>. Your password is never
          touched and never sent anywhere.
        </p>
      </details>

      <div className="actions">
        <button className="btn" onClick={onBack} disabled={busy}>
          ← Back
        </button>
        {busy ? (
          <button className="btn btn-secondary" onClick={handleCancel}>
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={!canSubmit}
          >
            {existing ? "Reconnect" : "Connect Last.fm"}
          </button>
        )}
        {existing && !busy && (
          <button className="btn btn-secondary" onClick={onComplete}>
            Continue →
          </button>
        )}
      </div>

      {busy && (
        <p className="hint">
          Your browser should now be open to Last.fm's authorization page.
          Click "Yes, allow access" — aScrobble will detect the callback
          automatically.
        </p>
      )}
    </div>
  );
}
