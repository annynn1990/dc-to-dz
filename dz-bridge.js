/* WongMing Discuz browser relay. */
(function () {
  "use strict";

  const BRIDGE_VERSION = "2026.09.29.16";
  window.__WONGMING_DZ_BRIDGE_RUNTIME__ = BRIDGE_VERSION;
  window.__WONGMING_DZ_BRIDGE_LAST_LOAD__ = Date.now();

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

  let relayWindow = null;
  let relayWindowReady = false;
  let relayInFlight = null;
  let relayEnabled = false;
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

  function ensureRelayButton() {
    const existing = document.getElementById("wongming-dz-relay-button");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.id = "wongming-dz-relay-button";
    wrap.dataset.wongmingBridgeVersion = BRIDGE_VERSION;
    wrap.setAttribute("style", [
      "position:fixed !important",
      "left:18px !important",
      "bottom:18px !important",
      "z-index:2147483647 !important",
      "display:block !important",
      "visibility:visible !important",
      "opacity:1 !important",
      "pointer-events:auto !important"
    ].join(";"));

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "你有一則簡訊");
    button.textContent = "你有一則簡訊";
    button.setAttribute("style", [
      "display:block !important",
      "visibility:visible !important",
      "opacity:1 !important",
      "padding:12px 18px !important",
      "border:1px solid #c9a227 !important",
      "border-radius:14px !important",
      "background:#fff8d9 !important",
      "color:#6b4f00 !important",
      "font:14px/1.2 sans-serif !important",
      "cursor:pointer !important",
      "box-shadow:0 5px 18px rgba(0,0,0,.22) !important"
    ].join(";"));

    button.addEventListener("click", () => {
      relayEnabled = true;
      wrap.remove();
      try {
        relayWindow = window.open(
          absolute(FORUM_ROOT + "forum.php?mod=post&action=newthread&fid=" + encodeURIComponent(FORUM_ID)),
          "WongMingDZRelay",
          "width=900,height=700,left=20,top=20"
        );
        relayWindowReady = !!relayWindow;
        if (!relayWindow) {
          relayEnabled = false;
          ensureRelayButton();
          return;
        }
        relayDiscordToDiscuz();
      } catch (error) {
        relayEnabled = false;
        setError(error);
        ensureRelayButton();
      }
    });

    wrap.appendChild(button);

    const oldNotice = document.getElementById("wongming-dz-relay-button");
    if (oldNotice) oldNotice.remove();

    const parent = document.body || document.documentElement;
    if (parent) {
      parent.appendChild(wrap);
      log("WongMing DZ Bridge", BRIDGE_VERSION, "通知已顯示，pending:", state.pending);
    }
  }


  async function checkPendingNotification() {
    if (relayEnabled) return;
    try {
      const data = await api("/", { method: "GET", headers: {} });
      state.pending = Number(data.pendingToDiscuz || 0);
      if (state.pending > 0) ensureRelayButton();
      else {
        const notice = document.getElementById("wongming-dz-relay-button");
        if (notice) notice.remove();
      }
    } catch (error) {
      setError(error);
    }
  }

  async function waitForRelayWindow() {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (!relayWindow || relayWindow.closed) {
        relayWindowReady = false;
        throw new Error("同步視窗已關閉，請按「啟用帝國郵政同步」");
      }

      try {
        const doc = relayWindow.document;
        const html = doc && doc.documentElement ? doc.documentElement.outerHTML : "";
        const text = doc && doc.body ? doc.body.textContent || "" : "";
        const form = doc && (doc.querySelector("form#postform") ||
          doc.querySelector('form[action*="forum.php"][action*="post"]'));

        if (form) return form;

        if (/請稍候|just a moment|checking your browser|verify you are human/i.test(html + text)) {
          state.lastError = "同步視窗正在等待 Cloudflare 驗證";
        }
      } catch (error) {
        if (!/SecurityError|cross-origin|Cross origin/i.test(String(error))) {
          throw error;
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error("同步視窗等待 Cloudflare／Discuz 發帖表單逾時");
  }

  async function postPendingItem(item) {
    if (!relayWindow || relayWindow.closed) {
      throw new Error("請先按「啟用帝國郵政同步」，讓瀏覽器開啟正常發帖視窗");
    }

    const form = await waitForRelayWindow();
    const hash = form.querySelector('[name="formhash"]');
    if (!hash || !hash.value) throw new Error("Discuz 發帖表單沒有 formhash");

    const subject = form.querySelector('[name="subject"]');
    const message = form.querySelector('[name="message"]');
    if (!subject || !message) throw new Error("Discuz 發帖欄位結構不同");

    subject.value = item.subject;
    subject.dispatchEvent(new Event("input", {bubbles:true}));
    subject.dispatchEvent(new Event("change", {bubbles:true}));

    const wysiwyg = form.querySelector('[name="wysiwyg"]');
    if (wysiwyg) wysiwyg.value = "0";

    message.value = item.message;
    message.dispatchEvent(new Event("input", {bubbles:true}));
    message.dispatchEvent(new Event("change", {bubbles:true}));

    // Discuz may submit editor contents from its iframe/editor rather than
    // trusting the textarea directly. Mirror the message into common editor frames.
    try {
      const frames = Array.from(relayWindow.document.querySelectorAll("iframe"));
      for (const frame of frames) {
        try {
          const body = frame.contentDocument && frame.contentDocument.body;
          if (!body) continue;
          const inEditor = frame.id === "e_iframe" ||
            /editor|message|iframe/i.test(frame.id || "") ||
            /editor|message/i.test(frame.name || "");
          if (!inEditor) continue;
          body.innerHTML = String(item.message)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\r?\n/g, "<br>");
          body.dispatchEvent(new Event("input", {bubbles:true}));
          body.dispatchEvent(new Event("change", {bubbles:true}));
        } catch {}
      }
    } catch {}

    const submit = form.querySelector('[name="topicsubmit"]') ||
      form.querySelector('button[type="submit"]') ||
      form.querySelector('input[type="submit"]') ||
      form.querySelector('[type="submit"]');
    if (!submit) throw new Error("找不到發表主題按鈕");

    // Discuz's server-side submitcheck() expects the submit control's
    // topicsubmit value. Native form.submit() does not include a submit
    // button's name/value, so explicitly add it.
    let topicSubmit = form.querySelector('input[name="topicsubmit"]');
    if (!topicSubmit) {
      topicSubmit = relayWindow.document.createElement("input");
      topicSubmit.type = "hidden";
      topicSubmit.name = "topicsubmit";
      form.appendChild(topicSubmit);
    }
    topicSubmit.value = "yes";

    // Submit the actual HTML form directly. This avoids depending on
    // Discuz's WYSIWYG iframe JavaScript and sends the textarea value.
    const beforeUrl = relayWindow.location.href;
    HTMLFormElement.prototype.submit.call(form);

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));

      try {
        const doc = relayWindow.document;
        const html = doc && doc.documentElement ? doc.documentElement.outerHTML : "";
        const text = doc && doc.body ? doc.body.textContent || "" : "";
        const currentUrl = relayWindow.location.href;

        if (/尚未登錄|尚未登入|請先登錄|沒有權限|權限不足/i.test(html + text)) {
          throw new Error("Discuz 拒絕發帖：登入狀態或權限有問題");
        }

        const tid =
          currentUrl.match(/thread-(\d+)(?:-|\.html)/i) ||
          currentUrl.match(/[?&]tid=(\d+)/i) ||
          html.match(/thread-(\d+)-1-1\.html/i);

        if (tid) {
          const successUrl = currentUrl;
          try { relayWindow.close(); } catch {}
          relayWindow = null;
          relayWindowReady = false;
          return successUrl;
        }

        if (currentUrl !== beforeUrl && /發表成功|發帖成功|主題已發布|succeedhandle|操作成功/i.test(html + text)) {
          const successUrl = currentUrl;
          try { relayWindow.close(); } catch {}
          relayWindow = null;
          relayWindowReady = false;
          return successUrl;
        }
      } catch (error) {
        if (/SecurityError|cross-origin|Cross origin/i.test(String(error))) continue;
        throw error;
      }
    }

    throw new Error("Discuz 表單已提交，但尚未確認建立主題");
  }

  async function relayDiscordToDiscuz() {
    if (!relayEnabled) return;
    if (relayInFlight) return relayInFlight;

    relayInFlight = (async () => {
      try {
        const data = await api("/bridge/pending?client=" + encodeURIComponent(RELAY_CLIENT_ID), { method: "GET", headers: {} });
        state.connected = true;
        state.pending = data.items ? data.items.length : 0;

        for (const item of data.items || []) {
          try {
            const url = await postPendingItem(item);
            const ack = await api("/bridge/ack", {
              method: "POST",
              body: JSON.stringify({
                id: item.id,
                clientId: RELAY_CLIENT_ID,
                ok: true,
                url,
                stage: "discuz-submit"
              })
            });
          state.lastOutbound = new Date().toISOString();
          state.lastAck = ack.result || null;
          log("Discord → Discuz 成功:", item.id, url, state.lastAck);
        } catch (error) {
          setError(error);
          try {
            const ack = await api("/bridge/ack", {
              method: "POST",
              body: JSON.stringify({
                id: item.id,
                clientId: RELAY_CLIENT_ID,
                ok: false,
                error: String(error && error.message ? error.message : error),
                stage: "discuz-submit"
              })
            });
            state.lastAck = ack.result || null;
            log("Discord → Discuz 失敗:", item.id, state.lastAck);
          } catch (ackError) {
            setError(ackError);
          }
          break;
        }
        }
      } catch (error) {
        setError(error);
      } finally {
        relayInFlight = null;
      }
    })();

    return relayInFlight;
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

    await checkPendingNotification();
    await scanForum();

    setInterval(() => {
      if (relayEnabled) {
        relayDiscordToDiscuz();
      } else {
        checkPendingNotification();
      }
    }, POLL_MS);
    setInterval(scanForum, SCAN_MS);

    window.dispatchEvent(new CustomEvent("wongming-dz-connected"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
