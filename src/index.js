import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const required = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing environment variable: " + key);
}

const ALLOWED_ORIGINS = new Set([
  "https://www.wongmingempire.com",
  "https://wongmingempire.com"
]);

const pendingToDiscuz = [];
const pendingById = new Map();
const deliveredToDiscord = new Set();

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

function enqueueDiscuz(item) {
  const id = String(item.id || "");
  if (!id || pendingById.has(id)) return false;

  const payload = {
    id,
    subject: String(item.subject || "Discord 訊息").slice(0, 80),
    message: String(item.message || "").slice(0, 12000),
    author: String(item.author || "Discord"),
    createdAt: new Date().toISOString()
  };

  pendingById.set(id, payload);
  pendingToDiscuz.push(payload);
  return true;
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

  if (req.method === "GET" && url.pathname === "/dz-bridge.js") {
    try {
      const script = await readFile(new URL("../dz-bridge.js", import.meta.url), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
      });
      return res.end(script);
    } catch (error) {
      console.error("Failed to serve browser relay script:", error);
      return json(res, 500, { ok: false, error: "bridge-script-unavailable" }, origin);
    }
  }

  if (req.method === "GET" && url.pathname === "/") {
    return json(res, 200, {
      ok: true,
      service: "dc-to-dz",
      mode: "browser-relay",
      discord: client?.user?.tag || "starting",
      pendingToDiscuz: pendingToDiscuz.length,
      time: new Date().toISOString()
    });
  }

  if (req.method === "GET" && url.pathname === "/bridge/pending") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" });
    }

    const clientId = String(url.searchParams.get("client") || "");
    const now = Date.now();
    const out = [];

    for (const item of pendingToDiscuz) {
      if (out.length >= 5) break;
      const claimedByOther = item.claimedUntil && item.claimedUntil > now && item.claimedBy && item.claimedBy !== clientId;
      if (claimedByOther) continue;

      item.claimedUntil = now + 60000;
      item.claimedBy = clientId || "";
      out.push(item);
    }

    return json(res, 200, { ok: true, items: out }, origin);
  }

  if (req.method === "POST" && url.pathname === "/bridge/ack") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" });
    }

    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body.id || "");
      const clientId = String(body.clientId || "");
      const relayOk = body.ok === true;
      const item = pendingById.get(id);
      const result = {
        messageId: id,
        relayOk,
        tid: String(body.tid || ""),
        url: String(body.url || ""),
        error: String(body.error || ""),
        stage: String(body.stage || ""),
        at: new Date().toISOString()
      };

      console.log(JSON.stringify({
        type: relayOk ? "discord_to_discuz_relay_success" : "discord_to_discuz_relay_failure",
        ...result
      }));

      if (!item) {
        console.log(JSON.stringify({
          type: "discord_to_discuz_ack_ignored",
          messageId: id,
          relayOk
        }));
        return json(res, 200, { ok: true, ignored: true, result }, origin);
      }

      if (item.claimedBy && clientId && item.claimedBy !== clientId) {
        return json(res, 409, { ok: false, error: "claim-owner-mismatch", result }, origin);
      }

      if (relayOk) {
        pendingById.delete(id);
        const index = pendingToDiscuz.findIndex(x => x.id === id);
        if (index >= 0) pendingToDiscuz.splice(index, 1);
      } else {
        item.claimedUntil = Date.now() + 120000;
        item.lastFailureAt = Date.now();
      }

      return json(res, 200, { ok: true, result }, origin);
    } catch {
      return json(res, 400, { ok: false, error: "invalid-json" }, origin);
    }
  }

  if (req.method === "POST" && url.pathname === "/bridge/forum-post") {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, error: "origin-not-allowed" });
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

  enqueueDiscuz({
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
    pending: pendingToDiscuz.length
  }));
});

client.login(process.env.DISCORD_BOT_TOKEN);
