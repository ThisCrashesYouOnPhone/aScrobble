import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { CloudflareAccount, CloudflareOauth } from "../types";
import {
  cloudflareListAccounts,
  cloudflareOauthLogin,
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

export function CloudflareStep({
  existingToken,
  existingOauth,
  existingAccountId,
  onComplete,
  onBack,
}: CloudflareStepProps) {
  const [oauthBusy, setOauthBusy] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthAccounts, setOauthAccounts] = useState<CloudflareAccount[]>([]);
  const [oauthSelection, setOauthSelection] = useState(existingAccountId ?? "");
  const [existingOauthLoaded, setExistingOauthLoaded] = useState(
    existingOauth && existingAccountId ? true : false
  );

  const [token, setToken] = useState(existingToken ?? "");
  const [manualPhase, setManualPhase] = useState<ManualPhase>("input");
  const [manualAccounts, setManualAccounts] = useState<CloudflareAccount[]>([]);
  const [manualSelection, setManualSelection] = useState(existingAccountId ?? "");
  const [manualError, setManualError] = useState<string | null>(null);

  const manualBusy = manualPhase === "validating" || manualPhase === "saving";
  const busy = oauthBusy || manualBusy || loadingAccounts;

  const [accountsLoadError, setAccountsLoadError] = useState<string | null>(null);

  // Initialize: if we have existing OAuth + account ID, mark as loaded immediately
  // so the Continue button shows right away, then try to load accounts in background
  useEffect(() => {
    if (existingOauth && existingAccountId) {
      setExistingOauthLoaded(true);
      setOauthSelection(existingAccountId);
    }
  }, [existingOauth, existingAccountId]);

  // Safety timeout: clear loading state after 5 seconds max to prevent indefinite loading
  useEffect(() => {
    if (loadingAccounts) {
      const timeout = setTimeout(() => {
        setLoadingAccounts(false);
      }, 5000);
      return () => clearTimeout(timeout);
    }
  }, [loadingAccounts]);

  // Background load of accounts (for the dropdown if multiple accounts exist)
  useEffect(() => {
    if (
      existingOauth &&
      existingAccountId &&
      oauthAccounts.length === 0 &&
      !loadingAccounts &&
      !oauthBusy
    ) {
      setLoadingAccounts(true);
      setAccountsLoadError(null);
      cloudflareListAccounts(existingOauth.access_token)
        .then((accounts) => {
          setOauthAccounts(accounts);
          if (accounts.length > 0 && !oauthSelection) {
            setOauthSelection(existingAccountId);
          }
        })
        .catch((e) => {
          const msg = typeof e === "string" ? e : (e as Error).message;
          console.warn("Could not load existing OAuth accounts:", e);
          setAccountsLoadError(msg ?? "Failed to load Cloudflare accounts");
          // Don't disable the continue button - user can still proceed
        })
        .finally(() => setLoadingAccounts(false));
    }
  }, [existingOauth, existingAccountId, oauthAccounts.length, loadingAccounts, oauthBusy, oauthSelection]);

  const openTokenPage = async () => {
    try {
      const url = await cloudflareTemplateUrl();
      await open(url);
    } catch (e) {
      console.error("failed to open token page:", e);
      open("https://dash.cloudflare.com/profile/api-tokens").catch(console.error);
    }
  };

  const handleOauthLogin = async () => {
    setOauthBusy(true);
    setOauthError(null);
    setOauthAccounts([]);
    setExistingOauthLoaded(false);
    try {
      const oauth = await cloudflareOauthLogin();
      const accounts = await cloudflareListAccounts(oauth.access_token);
      if (accounts.length === 0) {
        throw new Error(
          "Cloudflare login succeeded, but no accounts were returned for this user."
        );
      }

      if (accounts.length === 1) {
        await cloudflareSaveAccountId(accounts[0].id);
        onComplete();
        return;
      }

      setOauthAccounts(accounts);
      setOauthSelection(accounts[0].id);
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

  return (
    <div className="step-page card">
      <h2>Connect Cloudflare</h2>
      <p className="lead">
        aScrobble deploys the scrobbler to your own Cloudflare Workers account.
        It runs on Cloudflare's free tier and keeps working even when your PC
        is fully off.
      </p>

      {loadingAccounts && (
        <div className="status status-info">
          <span className="status-icon">◐</span>
          <div>Loading your Cloudflare accounts...</div>
        </div>
      )}

      {accountsLoadError && (
        <div className="status status-warning">
          <span className="status-icon">!</span>
          <div className="status-content">
            <div className="status-title">Could not refresh account list</div>
            <div className="meta">{accountsLoadError}</div>
          </div>
        </div>
      )}

      <div className="actions">
        <button
          className="btn btn-primary btn-large"
          onClick={handleOauthLogin}
          disabled={busy}
        >
          {oauthBusy ? "Opening browser..." : "Login with Cloudflare"}
        </button>
        {existingOauthLoaded && oauthSelection && (
          <button
            className="btn btn-accent btn-large"
            onClick={handleOauthContinue}
            disabled={oauthBusy}
          >
            Continue with saved session -&gt;
          </button>
        )}
      </div>

      <p className="muted">
        aScrobble uses Cloudflare's Wrangler OAuth flow to authenticate. You'll
        see "Wrangler" listed in your Cloudflare authorized applications - this
        is because Cloudflare doesn't offer OAuth app registration for
        third-party developers.
      </p>

      {existingOauth && (
        <div className="status status-ok">
          <span className="status-icon">OK</span>
          <div>
            Existing OAuth session found in keychain
            {existingAccountId ? ` (account ${existingAccountId.slice(0, 8)}...)` : ""}
          </div>
        </div>
      )}

      {/* Only show account picker if we loaded multiple accounts from OAuth */}
      {oauthAccounts.length > 1 && (
        <div className="form">
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

      {oauthError && (
        <div className="status status-error">
          <span className="status-icon">!</span>
          <div>{oauthError}</div>
        </div>
      )}

      <details className="how-it-works">
        <summary>Advanced: paste API token instead</summary>
        <ol className="numbered-steps">
          <li>
            <button className="link-btn" onClick={openTokenPage} disabled={busy}>
              Open the Cloudflare API tokens page -&gt;
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
              Save and continue -&gt;
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
