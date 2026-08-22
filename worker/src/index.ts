/**
 * Worker entry point.
 *
 * Two handlers:
 *   - scheduled(): fired by the cron trigger every 5 minutes
 *   - fetch():     HTTP endpoints the desktop app uses for monitoring
 *                  and manual triggering
 *
 * HTTP endpoints (all on the workers.dev URL):
 *   GET  /health              — open, returns 200 "ok"
 *   GET  /status?key=XXX      — returns ledger JSON (auth-gated)
 *   POST /trigger?key=XXX     — fires a manual poll (auth-gated)
 *
 * The auth key is set as STATUS_AUTH_KEY during deployment by the
 * desktop app. It prevents random traffic to the workers.dev URL
 * from reading or triggering the user's scrobbler.
 */
import type { Env } from "./env";
import { pollAndScrobble, getStatus, resetLedgerStats, updateTokens, clearCache } from "./scrobbler";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      pollAndScrobble(env).catch((err) => {
        console.error("scheduled() failed:", err);
      })
    );
  },

  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-ascrobble-auth",
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Lightweight health check — always open, no auth needed
    if (url.pathname === "/health") {
      return json(
        { ok: true, service: "aScrobble-scrobbler", version: "0.3.0" },
        200,
        corsHeaders
      );
    }

    // Everything else requires the STATUS_AUTH_KEY
    const providedKey =
      url.searchParams.get("key") ??
      request.headers.get("x-ascrobble-auth") ??
      "";

    if (!env.STATUS_AUTH_KEY) {
      console.error("STATUS_AUTH_KEY not set in worker environment");
      return json(
        { error: "Worker is misconfigured: STATUS_AUTH_KEY not set" },
        500,
        corsHeaders
      );
    }

    if (providedKey !== env.STATUS_AUTH_KEY) {
      console.warn("Unauthorized request to worker: invalid/missing auth key");
      return json({ error: "unauthorized" }, 401, corsHeaders);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      try {
        const ledger = await getStatus(env);
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/status request failed:", err);
        return json({ error: "failed to fetch status" }, 500, corsHeaders);
      }
    }

    if (url.pathname === "/reset-stats" && request.method === "POST") {
      try {
        const ledger = await resetLedgerStats(env);
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/reset-stats failed:", err);
        return json({ error: "failed to reset stats" }, 500, corsHeaders);
      }
    }

    if (url.pathname === "/clear-cache" && request.method === "POST") {
      try {
        let opts: Record<string, boolean> = {};
        if (request.headers.get("Content-Type")?.includes("application/json")) {
          opts = (await request.json().catch(() => ({}))) as Record<string, boolean>;
        }
        const res = await clearCache(env, opts);
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/clear-cache failed:", err);
        return json({ error: "failed to clear cache" }, 500, corsHeaders);
      }
    }

    if (url.pathname === "/update-tokens" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          apple_dev_token?: string;
          apple_user_token?: string;
        };
        const res = await updateTokens(
          env,
          body.apple_dev_token,
          body.apple_user_token
        );
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/update-tokens failed:", err);
        return json({ error: "failed to update tokens" }, 500, corsHeaders);
      }
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        await pollAndScrobble(env, true);
        const ledger = await getStatus(env);
        return json({ ok: true, triggered: true, ledger }, 200, corsHeaders);
      } catch (err) {
        console.error("/trigger failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }

    return json({ error: "not found" }, 404, corsHeaders);
  },
} satisfies ExportedHandler<Env>;


function json(
  data: unknown,
  status = 200,
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      ...corsHeaders,
    },
  });
}
