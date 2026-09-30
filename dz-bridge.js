/* WongMing Discuz browser relay. */
(function () {
  "use strict";

  const BRIDGE_VERSION = "2026.10.01.01";
  window.__WONGMING_DZ_BRIDGE_RUNTIME__ = BRIDGE_VERSION;
  window.__WONGMING_DZ_BRIDGE_LAST_LOAD__ = Date.now();

  const API = "https://dc-to-dz.onrender.com";
  const FORUM_ROOT = "/bbswm/";
  const FORUM_ID = "53";
  const SCAN_MS = 30000;
  const STORAGE_KEY = "wongming_dz_known_threads_v3";

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

  const RELAY_CLIENT_ID = (() => {
    try {
      const key = "wongming_dz_relay_client_id";
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("wm-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        sessionStorage.setItem(key, id);
      }
      return id;
    } catch {
      return "wm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
  })();

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
      let tid = "";

      // Discuz can expose thread links in either SEO form
      // (thread-123-1-1.html) or normal forum.php?mod=viewthread&tid=123 form.
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
      out.push({
        tid,
        title,
        url: absolute(href)
      });
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
      const known = loadKnown();

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
        // On first bootstrap, preserve the current forum state but also forward
        // the newest visible thread once, so the first fresh scan does not
        // silently discard the latest forum post.
        // Discuz's forum page is already ordered by the forum's own
        // newest/relevance rules. Use the first visible topic rather than
        // comparing tid numbers, which are not chronological across migrations.
        const newest = threads[0];

        // Bootstrap all currently visible topics as known EXCEPT the newest one.
        // The newest topic is only marked known after Discord delivery succeeds.
        threads.slice(1).forEach(t => known.add(t.tid));

        if (newest) {
          try {
            const threadResponse = await fetch(newest.url, {
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
              known.add(newest.tid);
            } else {
              const result = await api("/bridge/forum-post", {
                method: "POST",
                body: JSON.stringify({
                  tid: newest.tid,
                  title: newest.title,
                  content: content.slice(0, 6000),
                  url: newest.url
                })
              });

              if (result && result.ok === true) {
                known.add(newest.tid);
                log("Discuz → Discord 首次同步成功確認:", newest.tid, newest.title);
              } else {
                throw new Error("Discord relay did not confirm delivery");
              }
            }
          } catch (error) {
            // Do not mark the topic as known on failure. The next scan retries it.
            setError(error);
          }
        }

        saveKnown(known);
        state.lastScan = new Date().toISOString();
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
            saveKnown(known);
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
          saveKnown(known);
          log("Discuz → Discord 成功確認:", thread.tid, thread.title);
        } catch (error) {
          // Failed attempts remain retryable on the next scan.
          setError("同步主題 " + thread.tid + " 失敗：" + (error?.message || error));
        }
      }

      saveKnown(known);
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
