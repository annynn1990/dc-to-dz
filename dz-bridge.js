/* WongMing Discuz bridge loader endpoint. */
(function () {
  "use strict";

  if (window.__WONGMING_DZ_BRIDGE_RUNTIME__) return;
  window.__WONGMING_DZ_BRIDGE_RUNTIME__ = true;

  var state = window.WongMingDZBridge || {};
  state.service = "dc-to-dz";
  state.loadedAt = new Date().toISOString();
  state.connected = true;
  state.status = "bridge-script-loaded";
  window.WongMingDZBridge = state;

  window.dispatchEvent(new CustomEvent("wongming-dz-connected"));

  if (window.console && console.log) {
    console.log("[WongMing DZ] bridge script loaded");
  }
})();
