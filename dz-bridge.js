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

  function showChallengeNotice(url) {
    state.cloudflareBlocked = true;
    challengeBlockedUntil = Date.now() + CHALLENGE_COOLDOWN_MS;

    if (document.getElementById("wongming-dz-cf-notice")) return;

    const box = document.createElement("div");
    box.id = "wongming-dz-cf-notice";
    box.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483647",
      "width:min(420px,calc(100vw - 36px))",
      "padding:16px 18px",
      "border-radius:12px",
      "background:#fff",
      "border:1px solid #d7d7d7",
      "box-shadow:0 10px 35px rgba(0,0,0,.18)",
      "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#222"
    ].join(";");

    box.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">黃名帝國 Discord → Discuz 同步</div>' +
      '<div style="margin-bottom:10px">Discuz 的發帖網址目前要求瀏覽器完成一次 Cloudflare 驗證。請在正常分頁完成驗證，完成後回到論壇首頁即可自動繼續同步。</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button id="wongming-dz-cf-open" type="button" style="border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600">開啟發帖頁驗證</button>' +
        '<button id="wongming-dz-cf-close" type="button" style="border:1px solid #ccc;background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer">關閉提示</button>' +
      '</div>';

    document.body.appendChild(box);

    box.querySelector("#wongming-dz-cf-open").addEventListener("click", function () {
      window.open(url, "_blank", "noopener");
    });
    box.querySelector("#wongming-dz-cf-close").addEventListener("click", function () {
      box.remove();
    });
  }

  function clearChallengeNotice() {
    state.cloudflareBlocked = false;
    const box = document.getElementById("wongming-dz-cf-notice");
    if (box) box.remove();
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
    const url = absolute(FORUM_ROOT + "forum.php?mod=post&action=newthread&fid=" + encodeURIComponent(FORUM_ID));
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:2px;height:2px;left:-9999px;top:-9999px;border:0;";
    document.body.appendChild(frame);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Discuz 發帖頁載入逾時")), 20000);
        frame.onload = () => { clearTimeout(timer); resolve(); };
        frame.onerror = () => { clearTimeout(timer); reject(new Error("Discuz 發帖頁載入失敗")); };
        frame.src = url;
      });

      const doc = frame.contentDocument;
      if (!doc) throw new Error("無法取得 Discuz 發帖頁");
      const bodyText = doc.body ? doc.body.textContent || "" : "";
      const html = doc.documentElement ? doc.documentElement.outerHTML : "";

      if (/請稍候|just a moment|checking your browser|verify you are human/i.test(html)) {
        showChallengeNotice(url);
        throw new Error("Discuz 發帖頁仍是 Cloudflare 驗證頁");
      }

      clearChallengeNotice();

      const form = doc.querySelector("form#postform") ||
        doc.querySelector('form[action*="forum.php"][action*="post"]');
      if (!form) throw new Error("找不到 Discuz 發帖表單");
      const hash = form.querySelector('[name="formhash"]');
      if (!hash || !hash.value) throw new Error("找不到 formhash，請確認帝國郵政仍登入");

      const subject = form.querySelector('[name="subject"]');
      const message = form.querySelector('[name="message"]');
      if (!subject || !message) throw new Error("Discuz 發帖欄位結構不同");

      subject.value = item.subject;
      message.value = item.message;
      message.dispatchEvent(new Event("input", {bubbles:true}));
      message.dispatchEvent(new Event("change", {bubbles:true}));

      const submit = form.querySelector('[type="submit"]');
      if (!submit) throw new Error("找不到發表主題按鈕");

      form.requestSubmit(submit);
      await new Promise(r => setTimeout(r, 1800));

      const result = frame.contentDocument;
      const resultHtml = result && result.documentElement ? result.documentElement.outerHTML : "";
      const resultText = result && result.body ? result.body.textContent || "" : "";
      const resultUrl = frame.contentWindow.location.href;

      if (/尚未登錄|尚未登入|請先登錄|沒有權限|權限不足/i.test(resultText + resultHtml)) {
        throw new Error("Discuz 拒絕發帖：登入狀態或權限有問題");
      }
      if (/請稍候|just a moment|checking your browser|verify you are human/i.test(resultHtml)) {
        showChallengeNotice(url);
        throw new Error("Discuz 發帖回應仍是 Cloudflare 驗證頁");
      }
      if (/thread-\d+/i.test(resultUrl) || /發表成功|發帖成功|主題已發布|succeedhandle/i.test(resultText + resultHtml)) {
        return resultUrl;
      }
      throw new Error("Discuz 表單已提交，但尚未確認建立主題");
    } finally {
      frame.remove();
    }
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
