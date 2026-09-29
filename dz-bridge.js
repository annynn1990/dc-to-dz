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

  const state = {
    connected: false,
    lastOutbound: null,
    lastScan: null,
    lastError: null,
    pending: 0
  };

  window.WongMingDZBridge = state;

  function log() {
    if (window.console) console.log.apply(console, ["[WongMing DZ]"].concat([].slice.call(arguments)));
  }

  function setError(error) {
    state.lastError = String(error && error.message ? error.message : error);
    console.error("[WongMing DZ]", state.lastError);
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

  async function postPendingItem(item) {
    const postUrl = absolute(
      FORUM_ROOT + "forum.php?mod=post&action=newthread&fid=" + encodeURIComponent(FORUM_ID)
    );

    const pageResponse = await fetch(postUrl, {
      credentials: "same-origin",
      cache: "no-store"
    });
    const pageHtml = await pageResponse.text();

    if (/請稍候|just a moment|checking your browser|verify you are human/i.test(pageHtml)) {
      throw new Error("瀏覽器目前仍停在 Cloudflare 驗證頁");
    }

    const doc = new DOMParser().parseFromString(pageHtml, "text/html");
    const form =
      doc.querySelector("form#postform") ||
      doc.querySelector('form[action*="forum.php"][action*="post"]');

    if (!form) {
      throw new Error("找不到 Discuz 發帖表單，請確認「帝國郵政」仍保持登入");
    }

    const formHash = form.querySelector('input[name="formhash"]');
    if (!formHash || !formHash.value) {
      throw new Error("找不到 formhash，登入 Session 可能已失效");
    }

    const formData = new FormData(form);
    formData.set("subject", item.subject);
    formData.set("message", item.message);
    formData.set("topicsubmit", "yes");
    formData.set("posttime", String(Math.floor(Date.now() / 1000)));

    const action = absolute(form.getAttribute("action") || postUrl);
    const response = await fetch(action, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "follow"
    });

    const resultHtml = await response.text();
    if (/尚未登錄|尚未登入|請先登錄|沒有權限|權限不足/i.test(resultHtml)) {
      throw new Error("Discuz 拒絕發帖：登入狀態或論壇權限有問題");
    }

    if (/請稍候|just a moment|checking your browser|verify you are human/i.test(resultHtml)) {
      throw new Error("Discuz POST 又被 Cloudflare Challenge 攔下");
    }

    const success =
      /thread-\d+-1-1\.html/i.test(resultHtml) ||
      /發表成功|發帖成功|主題已發布|succeedhandle/i.test(resultHtml) ||
      /thread-\d+/i.test(response.url);

    if (!success) {
      throw new Error("Discuz 回應無法確認發帖成功");
    }

    return response.url;
  }

  async function relayDiscordToDiscuz() {
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
