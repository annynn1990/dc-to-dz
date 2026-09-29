import { createServer } from "node:http";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import Redis from "ioredis";

const required = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID", "REDIS_URL"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing environment variable: " + key);
}

const ALLOWED_ORIGINS = new Set([
  "https://www.wongmingempire.com",
  "https://wongmingempire.com"
]);

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true
});

const QUEUE_KEY = "dc-to-dz:queue";
const ITEM_PREFIX = "dc-to-dz:item:";
const CLAIM_PREFIX = "dc-to-dz:claim:";
const CLAIM_SECONDS = 60;

const deliveredToDiscord = new Set();

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

    const claimedNow = await redis.set(claimKey(id), "1", "EX", CLAIM_SECONDS, "NX");
    if (claimedNow === "OK") {
      out.push(JSON.parse(raw));
    }
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

function json(res, status, body, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    if (ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600"
      });
      return res.end();
    }
    res.writeHead(403);
    return res.end();
  }

  const url = new URL(req.url || "/", "http://localhost");
  console.log(JSON.stringify({ type: "http_request", method: req.method, path: url.pathname, origin }));

  if (req.method === "GET" && url.pathname === "/") {
    let pending = 0;
    try { pending = await redis.llen(QUEUE_KEY); } catch {}
    return json(res, 200, {
      ok: true,
      service: "dc-to-dz",
      mode: "browser-relay",
      queue: "redis",
      discord: client?.user?.tag || "starting",
      pendingToDiscuz: pending,
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/bridge/pending") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" }, origin);
    }

    try {
      const out = await getPendingItems(5);
      console.log(JSON.stringify({ type: "pending_delivered", count: out.length, ids: out.map(x => x.id) }));
      return json(res, 200, { ok: true, items: out }, origin);
    } catch (error) {
      console.error("Queue read failed:", error);
      return json(res, 503, { ok: false, error: "queue-unavailable" }, origin);
    }
  }

  if (req.method === "GET" && url.pathname === "/bridge/ack") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" }, origin);
    }
    const id = String(url.searchParams.get("id") || "");
    const ok = url.searchParams.get("ok") === "1";
    try {
      await acknowledge(id, ok);
      console.log(JSON.stringify({ type: "relay_ack", id, ok }));
      return json(res, 200, { ok: true }, origin);
    } catch (error) {
      console.error("Queue ack failed:", error);
      return json(res, 503, { ok: false, error: "queue-unavailable" }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/bridge/ack") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" }, origin);
    }

    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body.id || "");
      await acknowledge(id, body.ok === true);
      console.log(JSON.stringify({ type: "relay_ack", id, ok: body.ok === true }));
      return json(res, 200, { ok: true }, origin);
    } catch {
      return json(res, 400, { ok: false, error: "invalid-json" }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/bridge/client-error") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" }, origin);
    }

    try {
      const body = JSON.parse(await readBody(req));
      console.error(JSON.stringify({
        type: "browser_relay_error",
        id: String(body.id || ""),
        stage: String(body.stage || ""),
        error: String(body.error || ""),
        url: String(body.url || ""),
        title: String(body.title || ""),
        details: body.details || {}
      }));
      return json(res, 200, { ok: true }, origin);
    } catch {
      return json(res, 400, { ok: false, error: "invalid-json" }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/bridge/forum-post") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" }, origin);
    }

    try {
      const body = JSON.parse(await readBody(req));
      const tid = String(body.tid || "");
      const title = String(body.title || "Discuz 新主題").slice(0, 200);
      const content = String(body.content || "").slice(0, 6000);
      const threadUrl = String(body.url || "");

      if (!tid || deliveredToDiscord.has(tid)) {
        return json(res, 200, { ok: true, ignored: true }, origin);
      }

      if (!client.isReady()) {
        return json(res, 503, { ok: false, error: "discord-not-ready" }, origin);
      }

      const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
      if (!channel?.isTextBased()) {
        return json(res, 500, { ok: false, error: "channel-not-text" }, origin);
      }

      const message =
        "**DZ → Discord**\n" +
        "**" + title.replace(/\*/g, "") + "**\n" +
        (content || "(無內容)") +
        (threadUrl ? "\n<" + threadUrl + ">" : "");

      await channel.send(message);
      deliveredToDiscord.add(tid);

      if (deliveredToDiscord.size > 2000) {
        const first = deliveredToDiscord.values().next().value;
        if (first) deliveredToDiscord.delete(first);
      }

      return json(res, 200, { ok: true, delivered: true }, origin);
    } catch (error) {
      console.error("Forum -> Discord relay failed:", error);
      return json(res, 500, { ok: false, error: String(error?.message || error) }, origin);
    }
  }

  res.writeHead(404);
  res.end("Not Found");
});

const port = Number(process.env.PORT || 10000);
const serverReady = new Promise(resolve => {
  server.listen(port, "0.0.0.0", () => {
    console.log("Health/relay server listening on port " + port);
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

redis.on("ready", () => console.log("Redis queue connected"));
redis.on("error", error => console.error("Redis queue error:", error?.message || error));

client.once("ready", async () => {
  console.log("Discord bot online as " + client.user.tag);
  console.log("Guild: " + process.env.DISCORD_GUILD_ID);
  console.log("Channel: " + process.env.DISCORD_CHANNEL_ID);
  console.log("Browser relay mode ready");
  await serverReady;
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.guildId !== process.env.DISCORD_GUILD_ID) return;
  if (message.channelId !== process.env.DISCORD_CHANNEL_ID) return;

  const content = message.content || "";
  const subjectText = content.replace(/\s+/g, " ").trim().slice(0, 70) || "Discord 訊息";

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
              [...message.attachments.values()].map(a => "- " + a.url).join("\n")
            : ""
        ),
      author: message.author.username
    });

    console.log(JSON.stringify({
      type: "discord_to_discuz_queued",
      messageId: message.id,
      queued
    }));
  } catch (error) {
    console.error("Discord -> Discuz queue failed:", error);
  }
});

await redis.connect();
client.login(process.env.DISCORD_BOT_TOKEN);
