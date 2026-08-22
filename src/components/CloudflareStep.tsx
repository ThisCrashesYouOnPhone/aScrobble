import { useState, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { CloudflareAccount, CloudflareOauth } from "../types";
import {
  cloudflareListAccounts,
  cloudflareOauthLogin,
  cloudflareOauthLogout,
  cloudflareSaveAccountId,
  cloudflareSaveCredentials,
  cloudflareTemplateUrl,
  cloudflareValidateToken,
} from "../lib/tauri";

interface CloudflareStepProps {
  existingToken: string | null;
  existingOauth: CloudflareOauth | null;
  existingAccountId: string | null;
  onComplete: () => void;
  onBack: () => void;
}

type ManualPhase = "input" | "validating" | "valid" | "saving";
type SessionState = "checking" | "valid" | "expired" | "none";

export function CloudflareStep({
  existingToken,
  existingOauth,
  existingAccountId,
  onComplete,
  onBack,
}: CloudflareStepProps) {
  const [sessionState, setSessionState] = useState<SessionState>(
    existingOauth ? "checking" : existingToken ? "valid" : "none"
  );
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthAccounts, setOauthAccounts] = useState<CloudflareAccount[]>([]);
  const [oauthSelection, setOauthSelection] = useState(existingAccountId ?? "");
  const [oauthError, setOauthError] = useState<string | null>(null);

  const [token, setToken] = useState(existingToken ?? "");
  const [manualPhase, setManualPhase] = useState<ManualPhase>("input");
  const [manualAccounts, setManualAccounts] = useState<CloudflareAccount[]>([]);
  const [manualSelection, setManualSelection] = useState(existingAccountId ?? "");
  const [manualError, setManualError] = useState<string | null>(null);

  const sessionCheckDone = useRef(false);
  const manualBusy = manualPhase === "validating" || manualPhase === "saving";
  const busy = oauthBusy || manualBusy;

  // On mount: validate existing OAuth session proactively
  useEffect(() => {
    if (sessionCheckDone.current) return;
    sessionCheckDone.current = true;

    if (!existingOauth || !existingAccountId) {
      setSessionState(existingToken ? "valid" : "none");
      return;
    }

    // Try listing accounts to verify the token is still good
    cloudflareListAccounts(existingOauth.access_token)
      .then((accounts) => {
        setOauthAccounts(accounts);
        setOauthSelection(existingAccountId);
        setSessionState("valid");
      })
      .catch(() => {
        // Token is stale — auto-clear it
        cloudflareOauthLogout().catch(() => {});
        setSessionState("expired");
        setOauthError(
          "Your saved Cloudflare session has expired or been revoked. Please log in again."
        );
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openTokenPage = async () => {
    try {
      const url = await cloudflareTemplateUrl();
      await open(url);
    } catch {
      open("https://dash.cloudflare.com/profile/api-tokens").catch(console.error);
    }
  };

  const handleOauthLogin = async () => {
    setOauthBusy(true);
    setOauthError(null);
    setOauthAccounts([]);
    try {
      const oauth = await cloudflareOauthLogin();
      const accounts = await cloudflareListAccounts(oauth.access_token);
      if (accounts.length === 0) {
        throw new Error(
          "Cloudflare login succeeded, but no accounts were found for this user."
        );
      }

      if (accounts.length === 1) {
        await cloudflareSaveAccountId(accounts[0].id);
        onComplete();
        return;
      }

      setOauthAccounts(accounts);
      setOauthSelection(accounts[0].id);
      setSessionState("valid");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setOauthError(msg ?? "Cloudflare OAuth login failed");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleOauthContinue = async () => {
    if (!oauthSelection) return;
    setOauthBusy(true);
    setOauthError(null);
    try {
      await cloudflareSaveAccountId(oauthSelection);
      onComplete();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setOauthError(msg ?? "Failed to save Cloudflare account selection");
    } finally {
      setOauthBusy(false);
    }
  };

  const handleResetOauth = async () => {
    setOauthBusy(true);
    try {
      await cloudflareOauthLogout();
    } catch {
      // best effort
    } finally {
      setSessionState("none");
      setOauthAccounts([]);
      setOauthSelection("");
      setOauthError(null);
      setOauthBusy(false);
    }
  };

  const handleManualValidate = async () => {
    setManualError(null);
    setManualPhase("validating");
    try {
      await cloudflareValidateToken(token.trim());
      const accounts = await cloudflareListAccounts(token.trim());
      if (accounts.length === 0) {
        throw new Error(
          "Token is valid but has no accounts attached. Make sure it includes your account scope."
        );
      }
      setManualAccounts(accounts);
      setManualSelection(accounts[0]?.id ?? "");
      setManualPhase("valid");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setManualError(msg ?? "Cloudflare token validation failed");
      setManualPhase("input");
    }
  };

  const handleManualSave = async () => {
    if (!manualSelection) return;
    setManualPhase("saving");
    setManualError(null);
    try {
      await cloudflareSaveCredentials(token.trim(), manualSelection);
      onComplete();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setManualError(msg ?? "Failed to save Cloudflare credentials");
      setManualPhase("valid");
    }
  };

  const sessionValid = sessionState === "valid" && oauthSelection;

  return (
    <div className="step-page card">
      <h2>Connect Cloudflare</h2>
      <p className="lead">
        aScrobble deploys the scrobbler to your own Cloudflare Workers account.
        It runs on Cloudflare's free tier and keeps working even when your PC
        is fully off.
      </p>

      {/* Session check in progress */}
      {sessionState === "checking" && (
        <div className="status status-info">
          <span className="status-icon">◐</span>
          <div>Verifying saved Cloudflare session...</div>
        </div>
      )}

      {/* Session valid — show existing account + continue button */}
      {sessionState === "valid" && existingOauth && oauthSelection && (
        <div className="status status-ok">
          <span className="status-icon">OK</span>
          <div>
            <strong>Cloudflare session active</strong>
            <div className="meta" style={{ marginTop: 4 }}>
              Account: {oauthSelection.slice(0, 8)}…
            </div>
          </div>
        </div>
      )}

      {/* Expired session warning */}
      {sessionState === "expired" && (
        <div className="status status-error">
          <span className="status-icon">!</span>
          <div>
            <strong>Session expired</strong>
            <div className="meta" style={{ marginTop: 4 }}>
              {oauthError ?? "Your saved Cloudflare session is no longer valid."}
            </div>
          </div>
        </div>
      )}

      {/* Multiple account picker */}
      {oauthAccounts.length > 1 && (
        <div className="form" style={{ marginTop: 12 }}>
          <div className="form-row">
            <label>
              <span>Pick the Cloudflare account for this deployment</span>
              <select
                value={oauthSelection}
                onChange={(e) => setOauthSelection(e.target.value)}
                disabled={busy}
              >
                {oauthAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.id.slice(0, 8)}...)
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {/* OAuth error (login failures) */}
      {oauthError && sessionState !== "expired" && (
        <div className="status status-error" style={{ marginTop: 12 }}>
          <span className="status-icon">!</span>
          <div>{oauthError}</div>
        </div>
      )}

      {/* Primary action buttons */}
      <div className="actions" style={{ marginTop: 20 }}>
        {/* Continue with verified saved session */}
        {sessionValid && (
          <button
            className="btn btn-primary btn-large"
            onClick={handleOauthContinue}
            disabled={busy}
          >
            {oauthBusy ? "Saving..." : "Continue →"}
          </button>
        )}

        {/* Login / re-login */}
        <button
          className="btn btn-secondary btn-large"
          onClick={handleOauthLogin}
          disabled={busy}
        >
          {oauthBusy
            ? "Opening browser..."
            : sessionValid
            ? "Switch account"
            : "Login with Cloudflare"}
        </button>

        {/* Reset session */}
        {(sessionState === "valid" || sessionState === "expired") && (
          <button
            className="btn btn-secondary"
            onClick={handleResetOauth}
            disabled={busy}
          >
            Reset session
          </button>
        )}
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        aScrobble uses Cloudflare's Wrangler OAuth flow to authenticate. You'll
        see "Wrangler" listed in your Cloudflare authorized applications - this
        is because Cloudflare doesn't offer OAuth app registration for
        third-party developers.
      </p>

      {/* Advanced: manual API token */}
      <details className="how-it-works">
        <summary>Advanced: paste API token instead</summary>
        <ol className="numbered-steps">
          <li>
            <button className="link-btn" onClick={openTokenPage} disabled={busy}>
              Open the Cloudflare API tokens page →
            </button>
            <div className="muted">
              Use the pre-filled "Edit Cloudflare Workers" template, then copy
              the generated token.
            </div>
          </li>
          <li>Paste the token below and validate it.</li>
        </ol>

        <div className="form">
          <div className="form-row">
            <label>
              <span>API token</span>
              <textarea
                spellCheck={false}
                autoComplete="off"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (manualPhase === "valid") setManualPhase("input");
                }}
                placeholder="Paste your Cloudflare API token here"
                disabled={busy}
                rows={3}
              />
            </label>
          </div>

          {manualPhase === "valid" && manualAccounts.length > 0 && (
            <div className="form-row">
              <label>
                <span>Account</span>
                <select
                  value={manualSelection}
                  onChange={(e) => setManualSelection(e.target.value)}
                  disabled={busy}
                >
                  {manualAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.id.slice(0, 8)}...)
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        {manualError && (
          <div className="status status-error">
            <span className="status-icon">!</span>
            <div>{manualError}</div>
          </div>
        )}

        <div className="actions">
          {manualPhase === "input" && (
            <button
              className="btn btn-primary"
              onClick={handleManualValidate}
              disabled={!token.trim() || busy}
            >
              Validate token
            </button>
          )}
          {manualPhase === "validating" && (
            <button className="btn btn-primary" disabled>
              Validating...
            </button>
          )}
          {manualPhase === "valid" && (
            <button
              className="btn btn-primary"
              onClick={handleManualSave}
              disabled={!manualSelection || busy}
            >
              Save and continue →
            </button>
          )}
          {manualPhase === "saving" && (
            <button className="btn btn-primary" disabled>
              Saving...
            </button>
          )}
        </div>
      </details>

      <div className="actions">
        <button className="btn" onClick={onBack} disabled={busy}>
          &lt;- Back
        </button>
      </div>
    </div>
  );
}
