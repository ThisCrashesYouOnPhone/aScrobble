/**
 * Discord/Slack-compatible webhook notifier.
 *
 * Ported from v1/apple_scrobbler/notify.py. Silent no-op if
 * NOTIFY_WEBHOOK_URL isn't set, so the rest of the code doesn't
 * need to branch on whether notifications are enabled.
 */

export async function notifyTokenExpired(webhookUrl: string | undefined): Promise<void> {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    "🔴 **aScrobble**: Apple Music tokens expired (401).\n" +
      "Re-open the aScrobble desktop app to re-authenticate with Apple Music."
  );
}

export async function notifyMilestone(
  webhookUrl: string | undefined,
  total: number
): Promise<void> {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    `🎵 **aScrobble**: hit **${total.toLocaleString()}** total scrobbles`
  );
}

export async function notifySummary(
  webhookUrl: string | undefined,
  accepted: number,
  repeatCount: number,
  ignored: number
): Promise<void> {
  if (!webhookUrl || accepted === 0) return;
  const parts: string[] = [`**${accepted}** scrobbled`];
  if (repeatCount > 0) parts.push(`${repeatCount} repeat plays`);
  if (ignored > 0) parts.push(`${ignored} ignored`);
  await postMessage(webhookUrl, "🎵 " + parts.join(" · "));
}

async function postMessage(webhookUrl: string, message: string): Promise<void> {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord uses "content", Slack accepts "text"; sending both covers both.
      body: JSON.stringify({ content: message, text: message }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`Notify webhook ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("Notify webhook error:", e);
  }
}
