import type { StoredCredentials } from "../types";

interface WelcomeProps {
  onNext: () => void;
  hasCreds: StoredCredentials | null;
}

export function Welcome({ onNext, hasCreds }: WelcomeProps) {
  const allSet =
    hasCreds &&
    hasCreds.apple &&
    hasCreds.lastfm &&
    hasCreds.cloudflare_token &&
    hasCreds.cloudflare_account_id;

  return (
    <div className="welcome card">
      <h1>Scrobble Apple Music to Last.fm</h1>
      <p className="lead">
        amusic deploys a tiny scrobbler to your own Cloudflare account that
        polls your Apple Music recently-played list every 5 minutes and pushes
        new plays to Last.fm. After setup you can close this app — the
        scrobbler runs forever in the cloud.
      </p>

      <div className="features">
        <div className="feature">
          <div className="feature-icon">🍎</div>
          <div>
            <strong>Catches everything</strong>
            <p>Searched songs, radio, library — all of it.</p>
          </div>
        </div>
        <div className="feature">
          <div className="feature-icon">☁️</div>
          <div>
            <strong>Runs in the cloud</strong>
            <p>Cloudflare Workers free tier. Your PC can be off.</p>
          </div>
        </div>
        <div className="feature">
          <div className="feature-icon">🔒</div>
          <div>
            <strong>Self-hosted</strong>
            <p>Tokens go to your account, not ours. We have no server.</p>
          </div>
        </div>
      </div>

      <button className="btn btn-primary btn-large" onClick={onNext}>
        {allSet ? "Reconfigure" : "Get started"} →
      </button>

      {allSet && (
        <p className="hint">
          You've already configured everything. Pressing Get Started lets you
          rotate any credential without losing the others.
        </p>
      )}
    </div>
  );
}
