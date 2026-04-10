import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { StoredCredentials } from "../types";
import { storageClearAll } from "../lib/tauri";

interface DoneStepProps {
  creds: StoredCredentials;
  onReset: () => void;
}

export function DoneStep({ creds, onReset }: DoneStepProps) {
  const [confirmReset, setConfirmReset] = useState(false);

  const openCloudflareDashboard = () => {
    if (!creds.cloudflare_account_id) return;
    open(
      `https://dash.cloudflare.com/${creds.cloudflare_account_id}/workers/services/view/ascrobble-scrobbler/production`
    ).catch(console.error);
  };

  const openLastfmProfile = () => {
    if (!creds.lastfm) return;
    open(`https://www.last.fm/user/${creds.lastfm.username}`).catch(console.error);
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

  return (
    <div className="done card">
      <div className="big-check">✓</div>
      <h1>You're all set</h1>
      <p className="lead">
        The aScrobble scrobbler is live on your Cloudflare account and will poll
        Apple Music every 5 minutes from now on. You can close this app — the
        scrobbler runs entirely in the cloud.
      </p>

      <div className="summary">
        <div className="summary-row">
          <div className="summary-label">Scrobbling to</div>
          <button className="link-btn" onClick={openLastfmProfile}>
            last.fm/{creds.lastfm?.username ?? "?"} →
          </button>
        </div>
        <div className="summary-row">
          <div className="summary-label">Hosted on</div>
          <button className="link-btn" onClick={openCloudflareDashboard}>
            Cloudflare Workers (ascrobble-scrobbler) →
          </button>
        </div>
        <div className="summary-row">
          <div className="summary-label">Polls</div>
          <div>Every 5 minutes</div>
        </div>
        <div className="summary-row">
          <div className="summary-label">Apple tokens</div>
          <div>
            Captured{" "}
            {creds.apple
              ? new Date(creds.apple.captured_at).toLocaleDateString()
              : "?"}
            <span className="muted"> (re-scrape in ~6 months)</span>
          </div>
        </div>
      </div>

      <div className="next-steps">
        <h3>What now?</h3>
        <ul>
          <li>
            <strong>Play some music.</strong> Within 5–10 minutes you'll see
            scrobbles appear on your Last.fm profile.
          </li>
          <li>
            <strong>Close this app.</strong> It's not needed for the scrobbler
            to keep running. Open it again when your Apple tokens expire (about
            every 6 months) or to add ListenBrainz.
          </li>
          <li>
            <strong>View logs.</strong> The Cloudflare dashboard shows every
            cron run with what was detected and submitted.
          </li>
        </ul>
      </div>

      <div className="actions">
        <button
          className={`btn ${confirmReset ? "btn-danger" : "btn-secondary"}`}
          onClick={handleClearAll}
        >
          {confirmReset ? "Confirm: clear all credentials" : "Clear credentials"}
        </button>
        <button className="btn" onClick={onReset}>
          Reconfigure
        </button>
      </div>

      {confirmReset && (
        <p className="hint">
          This will remove all stored credentials from your operating system
          keychain. The deployed Cloudflare worker will keep running until you
          delete it manually from your Cloudflare dashboard.
        </p>
      )}
    </div>
  );
}
