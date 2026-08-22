import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "./Dashboard";
import * as workerApi from "../lib/worker-api";

vi.mock("../lib/tauri", () => ({
  getWorkerUrl: vi.fn().mockResolvedValue("https://test-worker.workers.dev"),
  getStatusAuthKey: vi.fn().mockResolvedValue("test-auth-key"),
  getWorkerStatus: vi.fn(),
  rotateAppleTokens: vi.fn(),
  loadUserSettings: vi.fn().mockResolvedValue({ poll_interval_minutes: 1 }),
  storageClearAll: vi.fn(),
  updatePollInterval: vi.fn().mockResolvedValue(undefined),
  redeployWorker: vi.fn().mockResolvedValue(undefined),
  appleDecodeTokenExpiry: vi.fn().mockReturnValue(null),
}));

vi.mock("../lib/worker-api", () => ({
  fetchStatus: vi.fn(),
  triggerScrobble: vi.fn().mockResolvedValue({ ok: true, triggered: true }),
  fetchLastfmAlbumArt: vi.fn().mockResolvedValue(null),
  resetWorkerStats: vi.fn(),
}));

const mockCreds = {
  apple: {
    developer_token: "dev_token",
    music_user_token: "user_token",
    captured_at: new Date().toISOString(),
  },
  lastfm: {
    username: "testuser",
    session_key: "lfm_session",
    api_key: "lfm_key",
    shared_secret: "lfm_secret",
  },
  cloudflare_oauth: null,
  cloudflare_token: "cf_token",
  cloudflare_account_id: "cf_account_id",
};

const mockLedger = {
  version: 1,
  last_run_iso: new Date().toISOString(),
  recent_scrobbles: [
    {
      artist: "Aphex Twin",
      track: "Avril 14th",
      album: "Drukqs",
      timestamp_iso: new Date().toISOString(),
      kind: "new" as const,
    },
  ],
  stats: {
    total_scrobbled: 42,
    total_runs: 10,
    total_errors: 0,
    last_success_iso: new Date().toISOString(),
    last_error_iso: null,
    last_error_message: null,
  },
  log_entries: [
    {
      timestamp_iso: new Date().toISOString(),
      step: "poll_idle",
      details: "Checked Apple tracks",
      level: "info" as const,
    },
  ],
};

describe("Dashboard component integration tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApi.fetchStatus).mockResolvedValue(mockLedger as any);
  });

  it("renders status active, recent scrobble and scrobble count", async () => {
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Avril 14th")).toBeInTheDocument();
      expect(screen.getByText("Aphex Twin")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("triggers manual scrobble poll on button click", async () => {
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Run scrobbler now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Run scrobbler now"));
    expect(workerApi.triggerScrobble).toHaveBeenCalledWith(
      "https://test-worker.workers.dev",
      "test-auth-key"
    );
  });

  it("toggles Worker Log panel collapse state", async () => {
    render(<Dashboard creds={mockCreds} onReset={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Worker Log/)).toBeInTheDocument();
    });

    const toggleBtn = screen.getByText(/Worker Log/);
    fireEvent.click(toggleBtn);
    // Click again to expand back
    fireEvent.click(toggleBtn);
    expect(screen.getByText("poll_idle")).toBeInTheDocument();
  });
});
