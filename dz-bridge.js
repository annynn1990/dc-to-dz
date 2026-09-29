/* Browser relay is retired. Discord ↔ Discuz now runs fully on Render. */
(function () {
  "use strict";
  window.WongMingDZBridge = {
    connected: true,
    mode: "fully-automatic",
    lastOutbound: null,
    lastScan: null,
    lastError: null,
    pending: 0,
    cloudflareBlocked: false
  };
})();
