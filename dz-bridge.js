/* WongMing Discuz browser relay. */
(function () {
  "use strict";

  if (window.__WONGMING_DZ_BRIDGE_RUNTIME__) return;
  window.__WONGMING_DZ_BRIDGE_RUNTIME__ = true;

  const API = "https://dc-to-dz.onrender.com";
  const FORUM_ROOT = "/bbswm/";
  const FORUM_ID = "53";
  const POLL_MS = 5000;
  const SCAN_MS = 15000;
  const STORAGE_KEY = "wongming_dz_known_threads_v1";
  const CHALLENGE_COOLDOWN_MS = 60000;

  const state = {
    connected: false,
    lastOutbound: null,
    lastScan: null,
    lastError: null,
    pending: 0,
    cloudflareBlocked: false
  };

  let challengeBlockedUntil = 0;

  window.WongMingDZBridge = state;

  function log() {
    if (window.console) console.log.apply(console, ["[WongMing DZ]"].concat([].slice.call(arguments)));
  }

  function setError(error) {
    state.lastError = String(error && error.message ? error.message : error);
    console.error("[WongMing DZ]", state.lastError);
  }

  function showChallengeNotice() {
    state.cloudflareBlocked = true;
    challengeBlockedUntil = Date.now() + CHALLENGE_COOLDOWN_MS;
  }

  function clearChallengeNotice() {
    state.cloudflareBlocked = false;
  }

  async function api(path, options) {
    const response = await fetch(API + path, Object.assign({
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" }
    }, options || {}));

    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!response.ok) {
      throw new Error("Bridge API " + response.status + ": " + (data && data.error ? data.error : text.slice(0, 200)));
    }

    return data || {};
  }

  function absolute(url) {
    return new URL(url, location.href).href;
  }

  function extractFormHash(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const input = doc.querySelector('[name="formhash"]');
    if (input && input.value) return input.value;

    const patterns = [
      /(?:var\\s+)?formhash\\s*[:=]\\s*["']([a-f0-9]+)["']/i,
      /FORMHASH\\s*=\\s*["']([a-f0-9]+)["']/i
    ];
    for (const re of patterns) {
      const match = html.match(re);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  async function getForumFormHash() {
    const candidates = [
      FORUM_ROOT + "forum.php?mod=forumdisplay&fid=" + encodeURIComponent(FORUM_ID),
      FORUM_ROOT
    ];

    for (const path of candidates) {
      const response = await fetch(absolute(path), {
        credentials: "same-origin",
        cache: "no-store"
      });
      const html = await response.text();

      if (/請稍候|just a moment|checking your browser|verify you are human/i.test(html)) {
        continue;
      }

      const formhash = extractFormHash(html);
      if (formhash) return formhash;
    }

    throw new Error("找不到可用的 Discuz formhash");
  }

  async function postPendingItem(item) {
    const formhash = await getForumFormHash();
    const postUrl = absolute(
      FORUM_ROOT + "forum.php?mod=post&action=newthread&fid=" + encodeURIComponent(FORUM_ID) + "&topicsubmit=yes"
    );

    const params = new URLSearchParams({
      formhash,
      subject: String(item.subject || "Discord 訊息").slice(0, 80),
      message: String(item.message || ""),
      posttime: String(Math.floor(Date.now() / 1000)),
      topicsubmit: "yes",
      usesig: "1",
      allownoticeauthor: "1",
      wysiwyg: "0"
    });

    const response = await fetch(postUrl, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "follow",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const resultHtml = await response.text();
    const resultUrl = response.url || "";

    if (/請稍候|just a moment|checking your browser|verify you are human/i.test(resultHtml)) {
      throw new Error("Discuz POST 仍被 Cloudflare 驗證攔下");
    }

    if (/尚未登錄|尚未登入|請先登錄|沒有權限|權限不足/i.test(resultHtml)) {
      throw new Error("Discuz 拒絕發帖：登入狀態或論壇權限有問題");
    }

    const threadMatch = resultHtml.match(/thread-(\\d+)-1-1\\.html/i);
    if (threadMatch) {
      return absolute("thread-" + threadMatch[1] + "-1-1.html");
    }

    if (/發表成功|發帖成功|主題已發布|succeedhandle/i.test(resultHtml)) {
      return resultUrl || absolute(FORUM_ROOT);
    }

    throw new Error("Discuz POST 已送出，但回應無法確認建立主題");
  }

  async function relayDiscordToDiscuz() {
    if (Date.now() < challengeBlockedUntil) return;

    try {
      const data = await api("/bridge/pending", { method: "GET", headers: {} });
      state.connected = true;
      state.pending = data.items ? data.items.length : 0;

      for (const item of data.items || []) {
        try {
          const url = await postPendingItem(item);
          await api("/bridge/ack", {
            method: "POST",
            body: JSON.stringify({ id: item.id, ok: true, url })
          });
          state.lastOutbound = new Date().toISOString();
          log("Discord → Discuz 成功:", item.id, url);
        } catch (error) {
          setError(error);
          try {
            await api("/bridge/client-error", {
              method: "POST",
              body: JSON.stringify({
                id: item.id,
                stage: "postPendingItem",
                error: String(error && error.message || error),
                url: location.href,
                title: document.title,
                details: { stack: String(error && error.stack || "") }
              })
            });
          } catch {}
          try {
            await api("/bridge/ack", {
              method: "POST",
              body: JSON.stringify({ id: item.id, ok: false })
            });
          } catch (ackError) {
            setError(ackError);
          }
          break;
        }
      }
    } catch (error) {
      setError(error);
    }
  }

  function loadKnown() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return new Set(Array.isArray(data) ? data.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function saveKnown(set) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...set].slice(-500)));
    } catch {}
  }

  function parseThreads(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const seen = new Set();

    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/thread-(\d+)-1-1\.html/);
      if (!m) continue;

      const tid = m[1];
      if (seen.has(tid)) continue;

      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue;

      seen.add(tid);
      out.push({
        tid,
        title,
        url: absolute(href)
      });
    }

    return out;
  }

  async function scanForum() {
    try {
      const url = absolute(FORUM_ROOT + "forum.php?mod=forumdisplay&fid=" + FORUM_ID);
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store"
      });
      const html = await response.text();

      if (/請稍候|just a moment|checking your browser|verify you are human/i.test(html)) {
        throw new Error("論壇頁面目前是 Cloudflare Challenge");
      }

      const threads = parseThreads(html);
      const known = loadKnown();

      if (known.size === 0) {
        threads.forEach(t => known.add(t.tid));
        saveKnown(known);
        state.lastScan = new Date().toISOString();
        return;
      }

      for (const thread of threads) {
        if (known.has(thread.tid)) continue;
        known.add(thread.tid);

        const threadResponse = await fetch(thread.url, {
          credentials: "same-origin",
          cache: "no-store"
        });
        const threadHtml = await threadResponse.text();

        if (/請稍候|just a moment|checking your browser|verify you are human/i.test(threadHtml)) {
          throw new Error("主題頁被 Cloudflare Challenge");
        }

        const threadDoc = new DOMParser().parseFromString(threadHtml, "text/html");
        const post = threadDoc.querySelector(".pcb");
        const content = (post ? post.textContent : "").replace(/\s+/g, " ").trim();

        if (content.includes("[DC->DZ]")) continue;

        await api("/bridge/forum-post", {
          method: "POST",
          body: JSON.stringify({
            tid: thread.tid,
            title: thread.title,
            content: content.slice(0, 6000),
            url: thread.url
          })
        });

        log("Discuz → Discord 成功:", thread.tid);
      }

      saveKnown(known);
      state.lastScan = new Date().toISOString();
      state.connected = true;
    } catch (error) {
      setError(error);
    }
  }

  async function start() {
    try {
      await api("/", { method: "GET", headers: {} });
      state.connected = true;
      log("瀏覽器 Relay 已連線");
    } catch (error) {
      setError(error);
    }

    await relayDiscordToDiscuz();
    await scanForum();

    setInterval(relayDiscordToDiscuz, POLL_MS);
    setInterval(scanForum, SCAN_MS);

    window.dispatchEvent(new CustomEvent("wongming-dz-connected"));
  }

  start();
})();
