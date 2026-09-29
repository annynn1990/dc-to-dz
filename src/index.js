import { createServer } from "node:http";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { DiscuzBridge } from "./discuz.js";

const required = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing environment variable: " + key);
}

// Render Web Service health port.
// The Discord gateway/bridge itself is a long-running worker, but the service
// is currently hosted as a web service, so keep a tiny HTTP listener alive.
const port = Number(process.env.PORT || 10000);
createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify({
    ok: true,
    service: "dc-to-dz",
    discord: "gateway-process",
    time: new Date().toISOString()
  }));
}).listen(port, "0.0.0.0", () => {
  console.log("Health server listening on port " + port);
});

const bridge = new DiscuzBridge({
  baseUrl: process.env.DZ_BASE_URL || "https://www.wongmingempire.com/bbswm/",
  forumId: Number(process.env.DZ_FORUM_ID || 53),
  username: process.env.DZ_USERNAME,
  password: process.env.DZ_PASSWORD,
  pollMs: Number(process.env.DZ_POLL_MS || 30000)
});

if (!bridge.username || !bridge.password) throw new Error("Missing DZ_USERNAME or DZ_PASSWORD");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once("ready", async () => {
  console.log("Discord bot online as " + client.user.tag);
  console.log("Guild: " + process.env.DISCORD_GUILD_ID);
  console.log("Channel: " + process.env.DISCORD_CHANNEL_ID);

  const startBridge = async () => {
    try {
      await bridge.start(async (payload) => {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (!channel?.isTextBased()) throw new Error("Configured Discord channel is not text based");
        await channel.send(payload);
      });
    } catch (error) {
      console.error("Bridge startup failed:", error);
      setTimeout(startBridge, bridge.pollMs);
    }
  };

  await startBridge();
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;

  try {
    await bridge.discordToDiscuz({
      messageId: message.id,
      author: message.author.username,
      content: message.content || "",
      attachments: [...message.attachments.values()].map(a => a.url),
      url: message.url
    });
  } catch (error) {
    console.error("Discord -> Discuz failed:", error);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
