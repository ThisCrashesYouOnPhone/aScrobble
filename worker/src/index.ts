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

    // Lightweight health check — always open, no auth needed
    if (url.pathname === "/health") {
      return json({ ok: true, service: "amusic-scrobbler", version: "0.2.0" });
    }

    // Everything else requires the STATUS_AUTH_KEY
    const providedKey =
      url.searchParams.get("key") ??
      request.headers.get("x-amusic-auth") ??
      "";
    if (!env.STATUS_AUTH_KEY || providedKey !== env.STATUS_AUTH_KEY) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const ledger = await getStatus(env);
      return json(ledger);
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      // Fire-and-forget so the desktop app gets a fast response,
      // but use waitUntil so the Worker actually completes the poll.
      const runPromise = pollAndScrobble(env).catch((err) => {
        console.error("/trigger failed:", err);
        return null;
      });
      ctx.waitUntil(runPromise);
      return json({ ok: true, triggered: true });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
