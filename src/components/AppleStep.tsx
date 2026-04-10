import { useState } from "react";
import type { AppleTokens } from "../types";
import { appleStartAuth, appleCancelAuth } from "../lib/tauri";

interface AppleStepProps {
  existing: AppleTokens | null;
  onComplete: () => void;
  onBack: () => void;
}

export function AppleStep({ existing, onComplete, onBack }: AppleStepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await appleStartAuth();
      // Wait a moment for credentials to be fully written to keychain
      await new Promise((resolve) => setTimeout(resolve, 200));
      onComplete();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setError(msg ?? "Apple sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    try {
      await appleCancelAuth();
    } catch {
      // best effort
    }
    setBusy(false);
  };

  return (
    <div className="step-page card">
      <h2>Connect Apple Music</h2>
      <p className="lead">
        Sign in with your Apple ID. aScrobble captures the same kind of token the
        Apple Music web player uses, so this works without an Apple Developer Program subscription.
      </p>

      {existing && !busy && (
        <div className="status status-ok">
          <span className="status-icon">✓</span>
          <div>
            <strong>Apple Music is connected</strong>
            <div className="meta">
              Captured {new Date(existing.captured_at).toLocaleString()}
            </div>
            <div className="meta" style={{ marginTop: 6, fontSize: "0.85em", opacity: 0.7 }}>
              If you proceed without re-authenticating, this token will be used for deployment.
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

      <details className="how-it-works">
        <summary>How does this work?</summary>
        <p>
          When you click Sign In, aScrobble opens a window to{" "}
          <code>music.apple.com</code> using your real default browser engine.
          You sign in normally with Apple ID and 2FA — exactly the same as the
          regular web player. After you're authenticated, aScrobble reads the same
          tokens MusicKit JS exposes to every web page (
          <code>MusicKit.getInstance().developerToken</code> and{" "}
          <code>.musicUserToken</code>) and stores them in your operating
          system keychain. Apple has known about this approach since 2019 and
          has not blocked it for personal-use apps.
        </p>
        <p>
          The tokens expire roughly every 6 months. When that happens, aScrobble
          will alert you and you can rotate them with one click — no need to
          re-authenticate Last.fm or Cloudflare.
        </p>
      </details>

      <div className="actions">
        <button className="btn" onClick={onBack} disabled={busy}>
          ← Back
        </button>
        {busy ? (
          <button className="btn btn-secondary" onClick={handleCancel}>
            Cancel sign-in
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleSignIn}>
            {existing ? "Re-authenticate" : "Sign in with Apple ID"}
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
          A new window has opened. Sign in to Apple Music there. aScrobble will
          detect the tokens automatically once you're in.
        </p>
      )}
    </div>
  );
}
