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
import { pollAndScrobble, getStatus } from "./scrobbler";

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
    ctx: ExecutionContext
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
        { ok: true, service: "aScrobble-scrobbler", version: "0.2.0" },
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

    if (url.pathname === "/trigger" && request.method === "POST") {
      // Fire-and-forget so the desktop app gets a fast response,
      // but use waitUntil so the Worker actually completes the poll.
      const runPromise = pollAndScrobble(env).catch((err) => {
        console.error("/trigger failed:", err);
        return null;
      });
      ctx.waitUntil(runPromise);
      return json({ ok: true, triggered: true }, 200, corsHeaders);
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
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}
