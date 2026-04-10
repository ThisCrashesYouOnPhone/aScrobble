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
import { Dashboard } from "./components/Dashboard";
import { Settings } from "./components/Settings";

function ReconfigureWarningModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-icon">⚠️</div>
          <h3>Reconfigure Credentials?</h3>
        </div>
        <div className="modal-body">
          <p>
            Reconfiguring will take you through the entire setup process again:
          </p>
          <ul>
            <li>Apple Music authentication</li>
            <li>Last.fm API credentials</li>
            <li>Cloudflare account setup</li>
          </ul>
          <p className="modal-hint">
            Your existing scrobbling data will be preserved, but you'll need to re-enter all credentials.
          </p>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Continue to Reconfigure
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ 
  step, 
  onNavigate, 
  onReconfigureClick,
  status 
}: { 
  step: WizardStep; 
  onNavigate: (s: WizardStep) => void;
  onReconfigureClick: () => void;
  status: { color: string; text: string };
}) {
  const isDashboard = step === "dashboard" || step === "done";
  const isSettings = step === "settings";
  const isSetup = ["welcome", "apple", "lastfm", "cloudflare", "deploy"].includes(step);
  const menuEnabled = isDashboard || isSettings;

  return (
    <aside className="app-sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">♫</div>
        <span>amusic</span>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section-title">Menu</div>
        <button 
          className={`sidebar-link ${isDashboard ? 'active' : ''}`}
          onClick={() => onNavigate("dashboard")}
          disabled={!menuEnabled}
        >
          <span className="sidebar-link-icon">📊</span>
          <span className="sidebar-link-text">Dashboard</span>
        </button>
        <button 
          className={`sidebar-link ${isSettings ? 'active' : ''}`}
          onClick={() => onNavigate("settings")}
          disabled={!menuEnabled}
        >
          <span className="sidebar-link-icon">⚙️</span>
          <span className="sidebar-link-text">Settings</span>
        </button>
        <button 
          className={`sidebar-link ${isSetup ? 'active' : ''}`}
          onClick={onReconfigureClick}
          disabled={!menuEnabled}
        >
          <span className="sidebar-link-icon">🔄</span>
          <span className="sidebar-link-text">Reconfigure</span>
        </button>
      </nav>

      <nav className="sidebar-nav">
        <div className="sidebar-section-title">Links</div>
        <a 
          className="sidebar-link"
          href="https://last.fm"
          target="_blank"
          rel="noreferrer"
        >
          <span className="sidebar-link-icon">🎵</span>
          <span className="sidebar-link-text">Last.fm</span>
        </a>
        <a 
          className="sidebar-link"
          href="https://dash.cloudflare.com"
          target="_blank"
          rel="noreferrer"
        >
          <span className="sidebar-link-icon">☁️</span>
          <span className="sidebar-link-text">Cloudflare</span>
        </a>
      </nav>

      {isDashboard && (
        <div className="sidebar-status">
          <div className="sidebar-status-header">
            <div className={`sidebar-status-dot ${status.color}`} />
            <span>Worker Status</span>
          </div>
          <div className="sidebar-status-text">{status.text}</div>
        </div>
      )}
    </aside>
  );
}

export default function App() {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState({ color: "gray", text: "Unknown" });
  const [showReconfigureWarning, setShowReconfigureWarning] = useState(false);

  useEffect(() => {
    storageGetAll()
      .then((c) => {
        setCreds(c);
        setSyncError(null);
        if (
          (c.cloudflare_oauth || c.cloudflare_token) &&
          c.cloudflare_account_id &&
          c.lastfm &&
          c.apple
        ) {
          setStep("dashboard");
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
      await new Promise((resolve) => setTimeout(resolve, 100));
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

  const isWizard = ["welcome", "apple", "lastfm", "cloudflare", "deploy"].includes(step);

  if (loading) {
    return (
      <div className="app loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className={`app ${isWizard ? 'wizard-mode' : ''}`}>
      {showReconfigureWarning && (
        <ReconfigureWarningModal
          onConfirm={() => {
            setShowReconfigureWarning(false);
            setStep("welcome");
          }}
          onCancel={() => setShowReconfigureWarning(false)}
        />
      )}
      
      {!isWizard && (
        <Sidebar 
          step={step} 
          onNavigate={setStep}
          onReconfigureClick={() => setShowReconfigureWarning(true)}
          status={workerStatus}
        />
      )}

      <main className="app-main">
        {!isWizard && (
          <header className="main-header">
            <div>
              <h1 className="main-title">
                {step === "dashboard" && "Dashboard"}
                {step === "done" && "Setup Complete"}
              </h1>
              <p className="main-subtitle">
                {step === "dashboard" && "Monitor your scrobbles and worker status"}
                {step === "done" && "Your scrobbler is running in the cloud"}
              </p>
            </div>
          </header>
        )}

        {syncError && (
          <div className="card status-error">
            <div className="card-header">
              <span className="status-icon">!</span>
              <div>
                <strong>Credential sync failed</strong>
                <div>{syncError}</div>
              </div>
            </div>
          </div>
        )}

        {isWizard && <Stepper current={step} />}

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
            onComplete={() => setStep("dashboard")}
            onBack={() => setStep("cloudflare")}
          />
        )}
        {step === "done" && creds && (
          <DoneStep creds={creds} onReset={() => setStep("welcome")} />
        )}
        {step === "dashboard" && creds && (
          <Dashboard 
            creds={creds} 
            onReset={() => setStep("welcome")}
            onStatusChange={setWorkerStatus}
          />
        )}
        {step === "settings" && (
          <Settings onBack={() => setStep("dashboard")} />
        )}
      </main>

      <footer className="app-footer">
        <span>amusic v0.2.0</span>
        <div className="footer-links">
          <a href="https://github.com/yourname/amusic" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="#" onClick={(e) => { e.preventDefault(); setStep("welcome"); }}>
            Reset
          </a>
        </div>
      </footer>
    </div>
  );
}
