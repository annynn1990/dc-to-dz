/* WongMing Discuz browser relay. */
(function () {
  "use strict";

  const BRIDGE_VERSION = "2026.10.08.01";
  if (window.__WONGMING_DZ_BRIDGE_STARTED__) return;
  window.__WONGMING_DZ_BRIDGE_STARTED__ = true;
  window.__WONGMING_DZ_BRIDGE_RUNTIME__ = BRIDGE_VERSION;
  window.__WONGMING_DZ_BRIDGE_LAST_LOAD__ = Date.now();

  const API = "https://dc-to-dz.onrender.com";
  const FORUM_ROOT = "/bbswm/";
  const FORUM_ID = "53";
  const SCAN_MS = 30000;
  const known = new Set();

  const state = {
    connected: false,
    lastOutbound: null,
    lastScan: null,
    lastError: null,
    pending: 0,
    scanInFlight: false
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

  const RELAY_CLIENT_ID =
    (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ("wm-" + Date.now() + "-" + Math.random().toString(36).slice(2));

  function parseThreads(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const seen = new Set();

    function isPinned(anchor) {
      const row = anchor.closest("tr");
      const tbody = anchor.closest("tbody");
      const markers = [
        row?.id || "",
        row?.className || "",
        tbody?.id || "",
        tbody?.className || ""
      ].join(" ").toLowerCase();
      return /stickthread|sticky|topthread|置頂|置顶/.test(markers);
    }

    const normalAnchors = doc.querySelectorAll(
      'tbody[id^="normalthread_"] a[href], tbody[id^="normalthread"] a[href]'
    );
    const anchors = normalAnchors.length ? normalAnchors : doc.querySelectorAll("a[href]");

    for (const a of anchors) {
      if (isPinned(a)) continue;

      const href = a.getAttribute("href") || "";
      let tid = "";
      const seo = href.match(/(?:^|\/)thread-(\d+)(?:-[^/?#]+)*\.html(?:[?#]|$)/i);

      if (seo) {
        tid = seo[1];
      } else {
        try {
          const parsed = new URL(href, location.href);
          const mod = parsed.searchParams.get("mod");
          const queryTid = parsed.searchParams.get("tid");
          if (/^viewthread$/i.test(mod || "") && /^\d+$/.test(queryTid || "")) {
            tid = queryTid;
          }
        } catch {}
      }

      if (!tid || seen.has(tid)) continue;

      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue;

      seen.add(tid);
      out.push({ tid, title, url: absolute(href) });
    }

    return out;
  }

  async function scanForum() {
    if (state.scanInFlight) return;
    state.scanInFlight = true;

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

      try {
        await api("/bridge/scan-status", {
          method: "POST",
          body: JSON.stringify({
            forumId: FORUM_ID,
            url,
            threadCount: threads.length,
            threadIds: threads.slice(0, 20).map(t => t.tid),
            lastKnownCount: known.size
          })
        });
      } catch {}

      if (known.size === 0) {
        // First run: seed current ordinary topics only.
        // Historical topics must never be mistaken for a new post.
        threads.forEach(t => known.add(t.tid));
        state.lastScan = new Date().toISOString();
        state.connected = true;
        log("首次掃描：已建立現有普通主題基準，共", threads.length, "篇；不轉發歷史文章。");
        return;
      }
      for (const thread of threads) {
        if (known.has(thread.tid)) continue;

        try {
          const threadResponse = await fetch(thread.url, {
            credentials: "same-origin",
            cache: "no-store"
          });
          const threadHtml = await threadResponse.text();

          if (/請稍候|just a moment|checking your browser|verify you are human/i.test(threadHtml)) {
            throw new Error("主題頁被 Cloudflare Challenge");
          }

          const threadDoc = new DOMParser().parseFromString(threadHtml, "text/html");
          const post =
            threadDoc.querySelector(".pcb") ||
            threadDoc.querySelector('[id^="postmessage_"]') ||
            threadDoc.querySelector(".t_f") ||
            threadDoc.querySelector(".message");
          const content = (post ? post.textContent : "").replace(/\s+/g, " ").trim();

          if (content.includes("[DC->DZ]")) {
            known.add(thread.tid);
                continue;
          }

          const result = await api("/bridge/forum-post", {
            method: "POST",
            body: JSON.stringify({
              tid: thread.tid,
              title: thread.title,
              content: content.slice(0, 6000),
              url: thread.url
            })
          });

          // Only remember a topic after the server confirms delivery.
          if (!result || result.ok !== true) {
            throw new Error("Discord relay did not confirm delivery");
          }

          known.add(thread.tid);
            log("Discuz → Discord 成功確認:", thread.tid, thread.title);
        } catch (error) {
          // Failed attempts remain retryable on the next scan.
          setError("同步主題 " + thread.tid + " 失敗：" + (error?.message || error));
        }
      }

      state.lastScan = new Date().toISOString();
      state.connected = true;
    } catch (error) {
      setError(error);
    } finally {
      state.scanInFlight = false;
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

    // Discord → Discuz is intentionally disabled.
    // Only keep the reverse Discuz → Discord scanner.
    setInterval(scanForum, SCAN_MS);
    scanForum();

    window.dispatchEvent(new CustomEvent("wongming-dz-connected"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
