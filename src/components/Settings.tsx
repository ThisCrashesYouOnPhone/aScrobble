import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  const [theme, setTheme] = useState<"dark" | "oled" | "auto">("dark");
  const [accentColor, setAccentColor] = useState<"brand" | "spotify" | "blue">("brand");
  const [pollingInterval, setPollingInterval] = useState(5);
  const [notifications, setNotifications] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [apiTestLoading, setApiTestLoading] = useState(false);
  const [apiTestResult, setApiTestResult] = useState<string | null>(null);

  // Load settings from storage
  useEffect(() => {
    const saved = localStorage.getItem("ascrobble-settings");
    if (saved) {
      const parsed = JSON.parse(saved);
      setTheme(parsed.theme || "dark");
      setAccentColor(parsed.accentColor || "brand");
      setPollingInterval(parsed.pollingInterval || 5);
      setNotifications(parsed.notifications !== false);
      setMinimizeToTray(parsed.minimizeToTray !== false);
      
      // Apply loaded theme immediately
      document.documentElement.setAttribute("data-theme", parsed.theme || "dark");
      document.documentElement.setAttribute("data-accent", parsed.accentColor || "brand");
    }
  }, []);

  // Auto-save and show toast
  const updateSetting = useCallback(<K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    const newSettings = {
      theme,
      accentColor,
      pollingInterval,
      notifications,
      minimizeToTray,
      [key]: value,
    };
    
    localStorage.setItem("ascrobble-settings", JSON.stringify(newSettings));
    
    if (key === 'theme') {
      document.documentElement.setAttribute("data-theme", value as string);
    }
    if (key === 'accentColor') {
      document.documentElement.setAttribute("data-accent", value as string);
    }
    
    setToast("Setting saved ✓");
    setTimeout(() => setToast(null), 2000);
  }, [theme, accentColor, pollingInterval, notifications, minimizeToTray]);

type SettingsState = {
  theme: "dark" | "oled" | "auto";
  accentColor: "brand" | "spotify" | "blue";
  pollingInterval: number;
  notifications: boolean;
  minimizeToTray: boolean;
};

  // Download logs (placeholder - would need Rust backend)
  const downloadLogs = async () => {
    setLogsLoading(true);
    try {
      // This would call a Rust command to get logs
      const logContent = [
        "[2024-01-15 10:30:15] Worker started",
        "[2024-01-15 10:30:20] Apple Music API: 200 OK",
        "[2024-01-15 10:30:21] Detected 3 new plays",
        "[2024-01-15 10:30:22] Last.fm: 3 scrobbles accepted",
        "[2024-01-15 10:35:15] Poll completed - no new plays",
      ].join("\n");
      
      const blob = new Blob([logContent], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ascrobble-logs-${new Date().toISOString().split("T")[0]}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to download logs:", e);
    } finally {
      setLogsLoading(false);
    }
  };

  const openDataFolder = async () => {
    try {
      await invoke("open_data_folder");
    } catch {
      // Fallback - show path
      alert("Data folder: %APPDATA%/aScrobble");
    }
  };

  const testAppleApi = async () => {
    setApiTestLoading(true);
    setApiTestResult(null);
    try {
      const result = await invoke<{
        tokens_present: boolean;
        developer_token_preview?: string;
        music_user_token_preview?: string;
        api_test?: { status: number; ok: boolean; body_preview?: string; error?: string };
        curl_command_recent?: string;
      }>("debug_export_apple_tokens");
      
      if (!result.tokens_present) {
        setApiTestResult("No Apple tokens found. Connect Apple Music first.");
        return;
      }

      const test = result.api_test;
      let output = `Token Test Results:\n\n`;
      output += `Developer Token: ${result.developer_token_preview}\n`;
      output += `User Token: ${result.music_user_token_preview}\n\n`;
      
      if (test?.error) {
        output += `API Test: FAILED - ${test.error}\n`;
      } else {
        output += `API Test: HTTP ${test?.status} (${test?.ok ? 'OK' : 'FAILED'})\n`;
        if (test?.body_preview) {
          output += `Response: ${test.body_preview.slice(0, 100)}...\n`;
        }
      }
      
      if (result.curl_command_recent) {
        output += `\n\nCurl command for testing:\n${result.curl_command_recent}`;
      }
      
      setApiTestResult(output);
    } catch (e) {
      setApiTestResult(`Error: ${e}`);
    } finally {
      setApiTestLoading(false);
    }
  };

  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <div 
      className={`toggle-switch ${checked ? 'active' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );

  return (
    <div className="settings-container">
      {toast && (
        <div className="toast">
          {toast}
        </div>
      )}
      
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Settings</h2>
            <p className="card-subtitle">Customize your aScrobble experience</p>
          </div>
          <button className="btn btn-secondary" onClick={onBack}>
            ← Back
          </button>
        </div>

        <div className="settings-section">
          <h3>Appearance</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Theme</label>
              <p>Choose your preferred color scheme for the app interface</p>
            </div>
            <div className="settings-control">
              <select 
                value={theme} 
                onChange={(e) => {
                  const value = e.target.value as "dark" | "oled" | "auto";
                  setTheme(value);
                  updateSetting('theme', value);
                }}
              >
                <option value="dark">🌙 Dark (Default)</option>
                <option value="oled">⚫ OLED Black</option>
                <option value="auto">💻 Auto (System)</option>
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Accent Color</label>
              <p>The accent color used for buttons and highlights throughout the app</p>
            </div>
            <div className="settings-control">
              <select 
                value={accentColor} 
                onChange={(e) => {
                  const value = e.target.value as "brand" | "spotify" | "blue";
                  setAccentColor(value);
                  updateSetting('accentColor', value);
                }}
              >
                <option value="brand">🔴 Brand Red</option>
                <option value="spotify">🟢 Spotify Green</option>
                <option value="blue">🔵 Blue</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>Behavior</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Minimize to Tray</label>
              <p>Keep the app running in the system tray when you close the window</p>
            </div>
            <div className="settings-control">
              <Toggle 
                checked={minimizeToTray} 
                onChange={(v) => {
                  setMinimizeToTray(v);
                  updateSetting('minimizeToTray', v);
                }} 
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Error Notifications</label>
              <p>Show desktop notifications when scrobbling errors occur</p>
            </div>
            <div className="settings-control">
              <Toggle 
                checked={notifications} 
                onChange={(v) => {
                  setNotifications(v);
                  updateSetting('notifications', v);
                }} 
              />
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>Advanced</h3>
          
          <div className="settings-row">
            <div className="settings-info">
              <label>Polling Interval</label>
              <p>How often to check Apple Music for new plays. Shorter intervals catch tracks faster but use more API calls.</p>
            </div>
            <div className="settings-control">
              <select 
                value={pollingInterval} 
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setPollingInterval(value);
                  updateSetting('pollingInterval', value);
                }}
              >
                <option value={1}>1 minute</option>
                <option value={2}>2 minutes</option>
                <option value={5}>5 minutes (recommended)</option>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-info">
              <label>Debug & Diagnostics</label>
              <p>Download logs or open the data folder for troubleshooting</p>
            </div>
            <div className="settings-control">
              <div className="settings-actions-row">
                <button 
                  className="btn btn-secondary btn-sm" 
                  onClick={downloadLogs}
                  disabled={logsLoading}
                >
                  {logsLoading ? "⏳ Exporting..." : "📥 Download Logs"}
                </button>
                <button 
                  className="btn btn-ghost btn-sm" 
                  onClick={openDataFolder}
                >
                  📁 Open Data Folder
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={testAppleApi}
                  disabled={apiTestLoading}
                >
                  {apiTestLoading ? "⏳ Testing..." : "🧪 Test Apple API"}
                </button>
              </div>
              {apiTestResult && (
                <div style={{ 
                  marginTop: '12px', 
                  padding: '12px', 
                  background: 'rgba(255,255,255,0.05)', 
                  borderRadius: '8px',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflow: 'auto'
                }}>
                  {apiTestResult}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="actions" style={{ marginTop: 'var(--space-xl)', justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={onBack}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;
