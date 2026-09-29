import { createServer } from "node:http";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import Redis from "ioredis";
import { DiscuzBridge } from "./discuz.js";

const required = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_CHANNEL_ID",
  "REDIS_URL",
  "DZ_BASE_URL",
  "DZ_USERNAME",
  "DZ_PASSWORD"
];

for (const key of required) {
  if (!process.env[key]) throw new Error("Missing environment variable: " + key);
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true
});

const QUEUE_KEY = "dc-to-dz:queue";
const ITEM_PREFIX = "dc-to-dz:item:";
const CLAIM_PREFIX = "dc-to-dz:claim:";
const CLAIM_SECONDS = 120;
const QUEUE_POLL_MS = 3000;

function itemKey(id) { return ITEM_PREFIX + id; }
function claimKey(id) { return CLAIM_PREFIX + id; }

async function enqueueDiscuz(item) {
  const id = String(item.id || "");
  if (!id) return false;

  const payload = {
    id,
    subject: String(item.subject || "Discord 訊息").slice(0, 80),
    message: String(item.message || "").slice(0, 12000),
    author: String(item.author || "Discord"),
    createdAt: new Date().toISOString()
  };

  const exists = await redis.exists(itemKey(id));
  if (exists) return false;

  const tx = redis.multi();
  tx.set(itemKey(id), JSON.stringify(payload));
  tx.rpush(QUEUE_KEY, id);
  await tx.exec();
  return true;
}

async function getPendingItems(limit = 5) {
  const ids = await redis.lrange(QUEUE_KEY, 0, 49);
  const out = [];

  for (const id of ids) {
    if (out.length >= limit) break;

    const claimed = await redis.exists(claimKey(id));
    if (claimed) continue;

    const raw = await redis.get(itemKey(id));
    if (!raw) {
      await redis.lrem(QUEUE_KEY, 0, id);
      continue;
    }

    const claimedNow = await redis.set(
      claimKey(id),
      "1",
      "EX",
      CLAIM_SECONDS,
      "NX"
    );

    if (claimedNow === "OK") out.push(JSON.parse(raw));
  }

  return out;
}

async function acknowledge(id, ok) {
  const key = itemKey(id);

  if (ok) {
    const tx = redis.multi();
    tx.lrem(QUEUE_KEY, 0, id);
    tx.del(key);
    tx.del(claimKey(id));
    await tx.exec();
  } else {
    await redis.del(claimKey(id));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    let pending = 0;
    try { pending = await redis.llen(QUEUE_KEY); } catch {}

    return json(res, 200, {
      ok: true,
      service: "dc-to-dz",
      mode: "fully-automatic",
      discord: client?.user?.tag || "starting",
      discuz: discuzStarted ? "ready" : "connecting",
      pendingToDiscuz: pending,
      time: new Date().toISOString()
    });
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

const port = Number(process.env.PORT || 10000);
const serverReady = new Promise(resolve => {
  server.listen(port, "0.0.0.0", () => {
    console.log("Health server listening on port " + port);
    resolve();
  });
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const bridge = new DiscuzBridge({
  baseUrl: process.env.DZ_BASE_URL,
  forumId: Number(process.env.DZ_FORUM_ID || 53),
  username: process.env.DZ_USERNAME,
  password: process.env.DZ_PASSWORD,
  pollMs: Number(process.env.DZ_POLL_MS || 30000)
});

let discuzStarted = false;
let queueWorkerRunning = false;

async function sendToDiscord(payload) {
  const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error("Configured Discord channel is not text based");
  }
  await channel.send(payload);
}

async function startDiscuz() {
  if (discuzStarted) return;

  while (!discuzStarted) {
    try {
      console.log("Starting fully automatic Discuz bridge...");
      await bridge.start(sendToDiscord);
      discuzStarted = true;
      console.log("Fully automatic Discuz bridge is ready.");
    } catch (error) {
      console.error("Discuz startup failed:", error?.stack || error);
      console.log("Discuz bridge will retry in 30 seconds.");
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
}

async function processQueue() {
  if (!discuzStarted || queueWorkerRunning) return;
  queueWorkerRunning = true;

  try {
    const items = await getPendingItems(3);

    for (const item of items) {
      try {
        console.log(JSON.stringify({
          type: "discord_to_discuz_processing",
          messageId: item.id,
          subject: item.subject
        }));

        const threadUrl = await bridge.createThread({
          subject: item.subject,
          message: item.message
        });

        await acknowledge(item.id, true);

        console.log(JSON.stringify({
          type: "discord_to_discuz_success",
          messageId: item.id,
          threadUrl
        }));
      } catch (error) {
        await acknowledge(item.id, false);

        console.error(JSON.stringify({
          type: "discord_to_discuz_failed",
          messageId: item.id,
          error: String(error?.message || error)
        }));

        if (/Cloudflare|Challenge|formhash|登入|登录|login/i.test(String(error?.message || ""))) {
          bridge.loggedIn = false;
        }
      }
    }
  } catch (error) {
    console.error("Queue worker failed:", error?.stack || error);
  } finally {
    queueWorkerRunning = false;
  }
}

client.once("ready", async () => {
  console.log("Discord bot online as " + client.user.tag);
  console.log("Guild: " + process.env.DISCORD_GUILD_ID);
  console.log("Channel: " + process.env.DISCORD_CHANNEL_ID);
  await serverReady;

  await startDiscuz();
  await processQueue();
  setInterval(processQueue, QUEUE_POLL_MS);
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;

  const content = message.content || "";
  const subjectText =
    content.replace(/\s+/g, " ").trim().slice(0, 70) || "Discord 訊息";

  try {
    const queued = await enqueueDiscuz({
      id: message.id,
      subject: "Discord｜" + message.author.username + "｜" + subjectText,
      message:
        "[DC->DZ] Discord 訊息 ID: " + message.id + "\n" +
        "作者：" + message.author.username + "\n" +
        "來源：" + message.url + "\n\n" +
        (content.trim() || "(此訊息沒有文字內容)") +
        (
          message.attachments.size
            ? "\n\n附件:\n" +
              [...message.attachments.values()]
                .map(a => "- " + a.url)
                .join("\n")
            : ""
        ),
      author: message.author.username
    });

    console.log(JSON.stringify({
      type: "discord_to_discuz_queued",
      messageId: message.id,
      queued
    }));

    await processQueue();
  } catch (error) {
    console.error("Discord -> Discuz queue failed:", error?.stack || error);
  }
});

redis.on("ready", () => console.log("Redis queue connected"));
redis.on("error", error => console.error("Redis queue error:", error?.message || error));

await redis.connect();
client.login(process.env.DISCORD_BOT_TOKEN);
