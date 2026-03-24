const extensionApi = globalThis.browser ?? globalThis.chrome;

const observedMedia = new WeakSet();

let lastActive = null;
let heartbeatTimer = null;

function allMediaElements() {
  return [...document.querySelectorAll("audio, video")];
}

function isAudible(element) {
  if (!element) {
    return false;
  }

  return !element.paused && !element.ended && !element.muted && element.volume > 0;
}

function anyAudibleMedia() {
  return allMediaElements().some((element) => isAudible(element));
}

function sendState(reason, force = false) {
  const active = anyAudibleMedia();
  if (!force && active === lastActive) {
    return;
  }

  lastActive = active;

  extensionApi.runtime.sendMessage({
    type: "competitor-media-state",
    sourceId: location.href,
    url: location.href,
    origin: location.origin,
    active,
    timestamp: Date.now(),
    reason
  }).catch(() => undefined);

  syncHeartbeat(active);
}

function syncHeartbeat(active) {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (!active) {
    return;
  }

  heartbeatTimer = setInterval(() => {
    extensionApi.runtime.sendMessage({
      type: "competitor-media-state",
      sourceId: location.href,
      url: location.href,
      origin: location.origin,
      active: true,
      timestamp: Date.now(),
      reason: "heartbeat"
    }).catch(() => undefined);
  }, 2000);
}

function attachMediaListeners(element) {
  if (observedMedia.has(element)) {
    return;
  }

  observedMedia.add(element);

  for (const eventName of ["play", "playing", "pause", "ended", "volumechange", "emptied"]) {
    element.addEventListener(eventName, () => {
      sendState(eventName, true);
    });
  }
}

function scanMedia() {
  for (const element of allMediaElements()) {
    attachMediaListeners(element);
  }

  sendState("scan");
}

function observeDom() {
  const observer = new MutationObserver(() => {
    scanMedia();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

extensionApi.runtime.onMessage.addListener((message) => {
  if (message?.type !== "state-request") {
    return undefined;
  }

  sendState("state-request", true);
  return undefined;
});

window.addEventListener("pagehide", () => sendState("pagehide", true));
window.addEventListener("beforeunload", () => sendState("beforeunload", true));

scanMedia();
observeDom();
