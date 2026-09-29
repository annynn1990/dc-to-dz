import * as cheerio from "cheerio";

function joinUrl(base, path) {
  return new URL(path, base).toString();
}

function parseCookies(response, jar) {
  const values = response.headers.getSetCookie?.() || [];
  for (const line of values) {
    const first = line.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1));
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

function extractFormHash(html) {
  const $ = cheerio.load(html);
  return $('input[name="formhash"]').attr("value") || null;
}

function extractLoginHash(html) {
  const $ = cheerio.load(html);
  const id = $('div[id^="main_messaqge_"]').first().attr("id");
  return id ? id.replace("main_messaqge_", "") : null;
}

export class DiscuzBridge {
  constructor({ baseUrl, forumId, username, password, pollMs }) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    this.forumId = forumId;
    this.username = username;
    this.password = password;
    this.pollMs = pollMs;
    this.cookies = new Map();
    this.loggedIn = false;
    this.knownThreads = new Set();
    this.started = false;
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("User-Agent", "dc-to-dz/1.1");
    const cookies = cookieHeader(this.cookies);
    if (cookies) headers.set("Cookie", cookies);
    const response = await fetch(joinUrl(this.baseUrl, path), { ...options, headers, redirect: "manual" });
    parseCookies(response, this.cookies);
    return response;
  }

  async login() {
    const page = await this.request("member.php?mod=logging&action=login");
    const html = await page.text();
    const formhash = extractFormHash(html);
    const loginhash = extractLoginHash(html);
    if (!formhash) throw new Error("Discuz login formhash not found");

    const params = new URLSearchParams({
      formhash,
      referer: this.baseUrl,
      loginfield: "username",
      username: this.username,
      password: this.password,
      questionid: "0",
      answer: "",
      cookietime: "2592000"
    });

    const path = "member.php?mod=logging&action=login&loginsubmit=yes&handlekey=login&loginhash=" +
      encodeURIComponent(loginhash || "") + "&inajax=1";
    const response = await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });
    const result = await response.text();

    if (!/succeed|登錄成功|登入成功/.test(result)) {
      throw new Error("Discuz login failed; check credentials or forum security verification.");
    }
    this.loggedIn = true;
    console.log("Discuz login OK");
  }

  async ensureLogin() {
    if (!this.loggedIn) await this.login();
  }

  async getPostFormHash() {
    await this.ensureLogin();
    const response = await this.request("forum.php?mod=post&action=newthread&fid=" + this.forumId);
    const html = await response.text();
    const formhash = extractFormHash(html);
    if (!formhash) throw new Error("Discuz post formhash not found; account may not have permission in fid=" + this.forumId);
    return formhash;
  }

  async createThread({ subject, message }) {
    const formhash = await this.getPostFormHash();
    const body = new URLSearchParams({
      formhash,
      subject: subject.slice(0, 80),
      message,
      posttime: String(Math.floor(Date.now() / 1000)),
      topicsubmit: "yes",
      usesig: "1",
      allownoticeauthor: "1",
      wysiwyg: "0"
    });

    const response = await this.request(
      "forum.php?mod=post&action=newthread&fid=" + this.forumId + "&topicsubmit=yes",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
    );
    const html = await response.text();

    if (/尚未登錄|尚未登入|沒有權限在該版塊發帖/.test(html)) {
      this.loggedIn = false;
      throw new Error("Discuz rejected the post; login or forum permission may have expired.");
    }

    const $ = cheerio.load(html);
    let threadUrl = null;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!threadUrl && /thread-\d+-1-1\.html/.test(href)) {
        threadUrl = new URL(href, this.baseUrl).toString();
      }
    });
    return threadUrl;
  }

  async fetchForumThreads() {
    await this.ensureLogin();
    const response = await this.request("forum.php?mod=forumdisplay&fid=" + this.forumId);
    const html = await response.text();

    if (/尚未登錄|尚未登入|您需要登錄/.test(html)) {
      this.loggedIn = false;
      throw new Error("Discuz session expired");
    }

    const $ = cheerio.load(html);
    const threads = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/thread-(\d+)-1-1\.html/);
      if (!match) return;
      const tid = match[1];
      if (threads.some(t => t.tid === tid)) return;
      const title = $(el).text().replace(/\s+/g, " ").trim();
      if (!title) return;
      threads.push({ tid, title, url: new URL(href, this.baseUrl).toString() });
    });
    return threads;
  }

  async fetchThreadFirstPost(thread) {
    const response = await this.request(thread.url);
    const html = await response.text();
    const $ = cheerio.load(html);
    const post = $(".pcb").first();
    const content = post.length ? post.text().replace(/\s+/g, " ").trim() : "";
    return { ...thread, content: content.slice(0, 1800) };
  }

  async start(sendToDiscord) {
    if (this.started) return;
    this.started = true;
    await this.ensureLogin();

    const initial = await this.fetchForumThreads();
    for (const t of initial) this.knownThreads.add(t.tid);
    console.log("Discuz bridge ready; seeded " + initial.length + " existing page-1 threads.");

    const poll = async () => {
      try {
        const current = await this.fetchForumThreads();
        const fresh = current.filter(t => !this.knownThreads.has(t.tid)).reverse();

        for (const t of fresh) {
          this.knownThreads.add(t.tid);
          const full = await this.fetchThreadFirstPost(t);
          if (full.content.includes("[DC->DZ]")) continue;
          await sendToDiscord(
            "**DZ → Discord**\n**" + full.title + "**\n" +
            (full.content || "(無內容)") + "\n<" + full.url + ">"
          );
        }

        if (this.knownThreads.size > 2000) {
          this.knownThreads = new Set(current.map(t => t.tid));
        }
      } catch (error) {
        console.error("Discuz -> Discord poll failed:", error);
        this.loggedIn = false;
      }
    };

    setInterval(poll, this.pollMs);
  }

  async discordToDiscuz({ messageId, author, content, attachments, url }) {
    const clean = content.trim();
    const links = attachments.length
      ? "\n\n附件:\n" + attachments.map(u => "- " + u).join("\n")
      : "";

    const message =
      "[DC->DZ] Discord 訊息 ID: " + messageId + "\n" +
      "作者：" + author + "\n" +
      "來源：" + url + "\n\n" +
      (clean || "(此訊息沒有文字內容)") + links;

    const subjectText = clean.replace(/\s+/g, " ").slice(0, 70) || "Discord 訊息";
    const subject = "Discord｜" + author + "｜" + subjectText;

    const threadUrl = await this.createThread({ subject, message });
    console.log(JSON.stringify({ type: "discord_to_discuz", messageId, threadUrl }));
    return threadUrl;
  }
}
