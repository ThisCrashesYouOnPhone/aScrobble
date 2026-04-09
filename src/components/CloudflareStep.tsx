import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { CloudflareAccount } from "../types";
import {
  cloudflareValidateToken,
  cloudflareListAccounts,
  cloudflareSaveCredentials,
  cloudflareTemplateUrl,
} from "../lib/tauri";

interface CloudflareStepProps {
  existing: string | null;
  onComplete: () => void;
  onBack: () => void;
}

type Phase = "input" | "validating" | "valid" | "saving";

export function CloudflareStep({ existing, onComplete, onBack }: CloudflareStepProps) {
  const [token, setToken] = useState(existing ?? "");
  const [phase, setPhase] = useState<Phase>(existing ? "valid" : "input");
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const openTokenPage = async () => {
    try {
      const url = await cloudflareTemplateUrl();
      await open(url);
    } catch (e) {
      console.error("failed to open token page:", e);
      // Fallback: try the bare URL
      open("https://dash.cloudflare.com/profile/api-tokens").catch(console.error);
    }
  };

  const handleValidate = async () => {
    setError(null);
    setPhase("validating");
    try {
      await cloudflareValidateToken(token.trim());
      const accts = await cloudflareListAccounts(token.trim());
      if (accts.length === 0) {
        throw new Error(
          "Token is valid but has no accounts attached. Make sure the token includes 'All accounts' or your specific account."
        );
      }
      setAccounts(accts);
      setSelectedAccount(accts[0]?.id ?? "");
      setPhase("valid");
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setError(msg ?? "Cloudflare token validation failed");
      setPhase("input");
    }
  };

  const handleSave = async () => {
    if (!selectedAccount) return;
    setPhase("saving");
    setError(null);
    try {
      await cloudflareSaveCredentials(token.trim(), selectedAccount);
      onComplete();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setError(msg ?? "Failed to save Cloudflare credentials");
      setPhase("valid");
    }
  };

  const busy = phase === "validating" || phase === "saving";

  return (
    <div className="step-page card">
      <h2>Connect Cloudflare</h2>
      <p className="lead">
        amusic deploys the scrobbler to your own Cloudflare Workers account.
        It runs on the free tier (we use ~2,000 of the 100,000 daily request
        budget) and your PC can be off completely.
      </p>

      <ol className="numbered-steps">
        <li>
          <button className="link-btn" onClick={openTokenPage}>
            Open the Cloudflare API tokens page →
          </button>
          <div className="muted">
            We've pre-filled the "Edit Cloudflare Workers" template. Just
            click "Continue to summary" then "Create Token".
          </div>
        </li>
        <li>Copy the token shown after creation.</li>
        <li>Paste it below.</li>
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
                if (phase === "valid") setPhase("input");
              }}
              placeholder="Paste your Cloudflare API token here"
              disabled={busy}
              rows={3}
            />
          </label>
        </div>

        {phase === "valid" && accounts.length > 0 && (
          <div className="form-row">
            <label>
              <span>Account</span>
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                disabled={busy}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            </label>
            {accounts.length > 1 && (
              <p className="hint">
                Pick the account that should host the scrobbler worker.
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="status status-error">
          <span className="status-icon">!</span>
          <div>{error}</div>
        </div>
      )}

      <details className="how-it-works">
        <summary>What does this token do?</summary>
        <p>
          The "Edit Cloudflare Workers" template grants permission to: create
          Worker scripts, manage Worker secrets, manage KV namespaces, and
          configure cron triggers — all scoped to your account. amusic uses
          all four. The token is stored in your operating system keychain
          (macOS Keychain, Windows Credential Manager, or Linux Secret
          Service) — never written to disk in plaintext.
        </p>
      </details>

      <div className="actions">
        <button className="btn" onClick={onBack} disabled={busy}>
          ← Back
        </button>
        {phase === "input" && (
          <button
            className="btn btn-primary"
            onClick={handleValidate}
            disabled={!token.trim() || busy}
          >
            Validate token
          </button>
        )}
        {phase === "validating" && (
          <button className="btn btn-primary" disabled>
            Validating…
          </button>
        )}
        {phase === "valid" && (
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!selectedAccount}
          >
            Save and continue →
          </button>
        )}
        {phase === "saving" && (
          <button className="btn btn-primary" disabled>
            Saving…
          </button>
        )}
      </div>
    </div>
  );
}
