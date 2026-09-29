/* WongMing Discuz homepage handshake relay. */
(function () {
  "use strict";
  if (window.__WONGMING_DZ_HANDSHAKE__) return;
  window.__WONGMING_DZ_HANDSHAKE__ = true;

  const API = "https://dc-to-dz.onrender.com";
  const FORUM_ROOT = "/bbswm/";
  const FORUM_ID = "53";
  const LEADER_KEY = "wongming_dz_homepage_leader_v2";
  const LEADER_TTL = 45000;

  const state = {
    connected: false,
    leader: false,
    pending: 0,
    lastOutbound: null,
    lastScan: null,
    lastError: null
  };
  window.WongMingDZBridge = state;

  const tabId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random());

  function claimLeader() {
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      const current = raw ? JSON.parse(raw) : null;
      if (!current || Number(current.expires) <= Date.now() || current.id === tabId) {
        localStorage.setItem(LEADER_KEY, JSON.stringify({
          id: tabId,
          expires: Date.now() + LEADER_TTL
        }));
      }
      state.leader = JSON.parse(localStorage.getItem(LEADER_KEY) || "{}").id === tabId;
    } catch {
      state.leader = true;
    }
    return state.leader;
  }

  function heartbeat() {
    if (!state.leader) return claimLeader();
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify({
        id: tabId,
        expires: Date.now() + LEADER_TTL
      }));
    } catch {}
  }

  async function api(path, options) {
    const r = await fetch(API + path, {
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
      ...(options || {})
    });
    const t = await r.text();
    let d = {};
    try { d = JSON.parse(t); } catch {}
    if (!r.ok) throw new Error("Bridge " + r.status + ": " + (d.error || t).slice(0, 180));
    return d;
  }

  function absolute(path) {
    return new URL(path, location.href).href;
  }

  async function postToDiscuz(item) {
    const isReply = item.mode === "reply";
    const url = absolute(
      FORUM_ROOT + "forum.php?mod=post&action=" +
      (isReply ? "reply&fid=" + FORUM_ID + "&tid=" + encodeURIComponent(item.tid)
               : "newthread&fid=" + FORUM_ID)
    );

    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    const html = await r.text();

    if (/Just a moment|請稍候|Checking your browser|Verify you are human/i.test(html)) {
      throw new Error("Cloudflare 驗證尚未通過");
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector("form#postform") ||
                 doc.querySelector('form[action*="forum.php"][action*="post"]');
    if (!form) throw new Error("找不到 Discuz 發帖表單");

    const data = new FormData(form);
    if (!isReply) data.set("subject", item.subject);
    data.set("message", item.message);

    const p = await fetch(url, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      redirect: "follow"
    });

    const resultHtml = await p.text();
    if (/Just a moment|請稍候|Checking your browser|Verify you are human/i.test(resultHtml)) {
      throw new Error("Discuz POST 被 Cloudflare 攔截");
    }

    const finalUrl = p.url || url;
    const m = finalUrl.match(/[?&]tid=(\d+)/i) || finalUrl.match(/thread-(\d+)-/i);
    const tid = m ? m[1] : "";
    if (!tid && !/發表成功|回覆成功|操作成功|succeedhandle/i.test(resultHtml)) {
      throw new Error("Discuz 未確認發帖成功");
    }
    return { url: finalUrl, tid };
  }

  async function outbound() {
    if (!state.leader) return;
    try {
      const data = await api("/bridge/pending");
      state.connected = true;
      state.pending = (data.items || []).length;

      for (const item of data.items || []) {
        try {
          const result = await postToDiscuz(item);
          await api("/bridge/ack", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ id: item.id, ok: true, tid: result.tid, url: result.url })
          });
          state.lastOutbound = new Date().toISOString();
        } catch (e) {
          state.lastError = String(e.message || e);
          await api("/bridge/ack", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ id: item.id, ok: false })
          });
          break;
        }
      }
    } catch (e) {
      state.lastError = String(e.message || e);
    }
  }

  async function inbound() {
    if (!state.leader) return;
    /* Reverse direction is intentionally kept lightweight for now. */
    state.lastScan = new Date().toISOString();
  }

  function start() {
    claimLeader();
    if (!state.leader) return;
    api("/").then(() => { state.connected = true; }).catch(e => state.lastError = String(e.message || e));
    outbound();
    setInterval(heartbeat, 10000);
    setInterval(outbound, 10000);
    setInterval(inbound, 30000);
  }

  start();
})();