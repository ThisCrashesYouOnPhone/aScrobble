import { useEffect, useState } from "react";
import type { StoredCredentials, WizardStep } from "./types";
import { storageGetAll } from "./lib/tauri";
import { Stepper } from "./components/Stepper";
import { Welcome } from "./components/Welcome";
import { AppleStep } from "./components/AppleStep";
import { LastfmStep } from "./components/LastfmStep";
import { CloudflareStep } from "./components/CloudflareStep";
import { DeployStep } from "./components/DeployStep";
import { DoneStep } from "./components/DoneStep";

export default function App() {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Load any previously-stored credentials. If everything is already set,
  // we can jump straight to the deploy or done step.
  useEffect(() => {
    storageGetAll()
      .then((c) => {
        setCreds(c);
        setSyncError(null);
        // Resume from where the user left off
        if (
          (c.cloudflare_oauth || c.cloudflare_token) &&
          c.cloudflare_account_id &&
          c.lastfm &&
          c.apple
        ) {
          setStep("deploy");
        }
      })
      .catch((e) => {
        console.error("storage_get_all failed:", e);
        const msg = typeof e === "string" ? e : (e as Error).message;
        setSyncError(msg ?? "Failed to read credentials from keychain");
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshCreds = async () => {
    try {
      const next = await storageGetAll();
      setCreds(next);
      setSyncError(null);
      return true;
    } catch (e) {
      console.error("refresh failed:", e);
      const msg = typeof e === "string" ? e : (e as Error).message;
      setSyncError(msg ?? "Failed to refresh credentials from keychain");
      return false;
    }
  };

  if (loading) {
    return (
      <div className="app loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">amusic</div>
        <div className="tagline">Apple Music → Last.fm, on autopilot</div>
      </header>

      {step !== "welcome" && step !== "done" && <Stepper current={step} />}

      <main className="app-main">
        {syncError && (
          <div className="status status-error">
            <span className="status-icon">!</span>
            <div>
              <strong>Credential sync failed</strong>
              <div>{syncError}</div>
            </div>
          </div>
        )}
        {step === "welcome" && (
          <Welcome onNext={() => setStep("apple")} hasCreds={creds} />
        )}
        {step === "apple" && (
          <AppleStep
            existing={creds?.apple ?? null}
            onComplete={async () => {
              const ok = await refreshCreds();
              if (!ok) return;
              setStep("lastfm");
            }}
            onBack={() => setStep("welcome")}
          />
        )}
        {step === "lastfm" && (
          <LastfmStep
            existing={creds?.lastfm ?? null}
            onComplete={async () => {
              const ok = await refreshCreds();
              if (!ok) return;
              setStep("cloudflare");
            }}
            onBack={() => setStep("apple")}
          />
        )}
        {step === "cloudflare" && (
          <CloudflareStep
            existingToken={creds?.cloudflare_token ?? null}
            existingOauth={creds?.cloudflare_oauth ?? null}
            existingAccountId={creds?.cloudflare_account_id ?? null}
            onComplete={async () => {
              const ok = await refreshCreds();
              if (!ok) return;
              setStep("deploy");
            }}
            onBack={() => setStep("lastfm")}
          />
        )}
        {step === "deploy" && creds && (
          <DeployStep
            creds={creds}
            onComplete={() => setStep("done")}
            onBack={() => setStep("cloudflare")}
          />
        )}
        {step === "done" && creds && (
          <DoneStep creds={creds} onReset={() => setStep("welcome")} />
        )}
      </main>

      <footer className="app-footer">
        <span>v0.2.0</span>
        <span className="dot">·</span>
        <a
          href="https://github.com/yourname/amusic"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </footer>
    </div>
  );
}
