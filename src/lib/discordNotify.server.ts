import "server-only";

// Discord Webhook 送信（2026-09-18導入、日次/月次サマリー用）。Slackアカウント
// が無いため、チャンネル設定からURLを1つ発行するだけで済むDiscordを採用。
// 必要な env（Vercel）: DISCORD_WEBHOOK_URL。

export type DiscordEmbedField = { name: string; value: string; inline?: boolean };

export async function sendDiscordEmbed(args: {
  title: string;
  description?: string;
  fields?: DiscordEmbedField[];
  color?: number;
}): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn("[discordNotify] DISCORD_WEBHOOK_URL not configured, skipping.");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: args.title,
            description: args.description,
            color: args.color ?? 0x8a5cf6,
            fields: args.fields,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discordNotify] webhook failed (${res.status}): ${text.slice(0, 500)}`);
    }
  } catch (err) {
    console.error("[discordNotify] webhook request failed:", err);
  }
}
