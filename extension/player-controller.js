const extensionApi = globalThis.browser ?? globalThis.chrome;

const PLAYER_HOSTS = {
  "music.youtube.com": "youtubeMusic",
  "open.spotify.com": "spotify"
};

const observedMedia = new WeakSet();
const expectedCommandTokens = new Map();
const stateRefreshTimers = new Set();

let currentAutoPauseToken = null;
let lastReportSignature = null;
let lastTimeUpdateAt = 0;

function detectPlayerId() {
  return PLAYER_HOSTS[location.hostname] ?? null;
}

function collectSearchRoots(root = document, roots = []) {
  roots.push(root);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) {
      collectSearchRoots(node.shadowRoot, roots);
    }

    node = walker.nextNode();
  }

  return roots;
}

function deepQueryAll(selector) {
  return collectSearchRoots().flatMap((root) => [...root.querySelectorAll(selector)]);
}

function allMediaElements() {
  return deepQueryAll("audio, video");
}

function spotifyPlayPauseButton() {
  return deepQueryAll('button[data-testid="control-button-playpause"]').find(Boolean) ?? null;
}

function spotifyPlayingFromButton(button) {
  if (!button) {
    return null;
  }

  const labels = [
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLowerCase();

  if (!labels) {
    return null;
  }

  if (labels.includes("pause")) {
    return true;
  }

  if (labels.includes("play")) {
    return false;
  }

  return null;
}

function mediaSessionPlaybackState() {
  try {
    return navigator.mediaSession?.playbackState ?? "none";
  } catch (_error) {
    return "none";
  }
}

function pickActiveMediaElement() {
  const media = allMediaElements();
  if (media.length === 0) {
    return null;
  }

  const playing = media.filter((element) => !element.paused && !element.ended);
  if (playing.length > 0) {
    return playing.sort((left, right) => {
      return (right.currentTime || 0) - (left.currentTime || 0);
    })[0];
  }

  const progressed = media.filter((element) => (element.currentTime || 0) > 0 || element.readyState >= 2);
  if (progressed.length > 0) {
    return progressed.sort((left, right) => {
      return (right.currentTime || 0) - (left.currentTime || 0);
    })[0];
  }

  return media[0];
}

function currentPlayerState() {
  const playerId = detectPlayerId();
  const player = pickActiveMediaElement();
  const playPauseButton = playerId === "spotify" ? spotifyPlayPauseButton() : null;
  const mediaSessionState = mediaSessionPlaybackState();
  const buttonPlaying = spotifyPlayingFromButton(playPauseButton);

  let playing = Boolean(player && !player.paused && !player.ended);
  if (!playing && mediaSessionState === "playing") {
    playing = true;
  }

  if (buttonPlaying !== null) {
    playing = buttonPlaying;
  }

  return {
    playerId,
    player,
    playPauseButton,
    playing,
    currentTime: Number(player?.currentTime ?? 0)
  };
}

function classifyCause(playingNow) {
  const now = Date.now();

  for (const [token, pending] of expectedCommandTokens.entries()) {
    if (now > pending.expiresAt) {
      expectedCommandTokens.delete(token);
      continue;
    }

    if (pending.command === "pause" && !playingNow) {
      expectedCommandTokens.delete(token);
      currentAutoPauseToken = token;
      return { cause: "extension", token };
    }

    if (pending.command === "play" && playingNow) {
      expectedCommandTokens.delete(token);
      currentAutoPauseToken = null;
      return { cause: "extension", token };
    }
  }

  return { cause: "user-or-page", token: null };
}

function reportState(reason, force = false) {
  const { playerId, player, playing, currentTime, playPauseButton } = currentPlayerState();
  const causeInfo = classifyCause(playing);
  const signature = [
    playerId,
    playing,
    Math.floor(currentTime),
    Boolean(player),
    Boolean(playPauseButton),
    causeInfo.cause,
    causeInfo.token ?? ""
  ].join(":");

  if (!force && signature === lastReportSignature && reason !== "state-request") {
    return;
  }

  lastReportSignature = signature;

  extensionApi.runtime.sendMessage({
    type: "player-state",
    playerId,
    url: location.href,
    playing,
    currentTime,
    cause: causeInfo.cause,
    token: causeInfo.token,
    reason,
    hasPlayer: Boolean(player),
    hasPlayPauseButton: Boolean(playPauseButton)
  }).catch(() => undefined);
}

function attachMediaListeners(element) {
  if (observedMedia.has(element)) {
    return;
  }

  observedMedia.add(element);

  for (const eventName of ["play", "playing", "pause", "ended", "loadedmetadata"]) {
    element.addEventListener(eventName, () => {
      reportState(eventName, true);
    });
  }

  element.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastTimeUpdateAt < 1000) {
      return;
    }

    lastTimeUpdateAt = now;
    reportState("timeupdate");
  });
}

function scanMedia() {
  for (const element of allMediaElements()) {
    attachMediaListeners(element);
  }

  reportState("scan");
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

function registerInteractionCancellation() {
  const cancelAutoResume = () => {
    if (!currentAutoPauseToken) {
      return;
    }

    const token = currentAutoPauseToken;
    currentAutoPauseToken = null;

    extensionApi.runtime.sendMessage({
      type: "player-user-interaction",
      token,
      playerId: detectPlayerId(),
      url: location.href
    }).catch(() => undefined);
  };

  window.addEventListener("pointerdown", cancelAutoResume, true);
  window.addEventListener("keydown", cancelAutoResume, true);
}

function scheduleStateRefresh(reason) {
  for (const delayMs of [120, 500, 1200]) {
    const timer = setTimeout(() => {
      stateRefreshTimers.delete(timer);
      reportState(reason, true);
    }, delayMs);

    stateRefreshTimers.add(timer);
  }
}

function clickButton(button) {
  button.click();
}

async function runCommand(message) {
  const state = currentPlayerState();
  const { playerId, player, playPauseButton, playing } = state;

  if (message.command === "state-request") {
    reportState("state-request", true);
    return;
  }

  if (!player && !playPauseButton) {
    extensionApi.runtime.sendMessage({
      type: "player-command-result",
      playerId,
      command: message.command,
      token: message.token,
      ok: false,
      error: "No controllable player found"
    }).catch(() => undefined);
    return;
  }

  expectedCommandTokens.set(message.token, {
    command: message.command,
    expiresAt: Date.now() + 3000
  });

  try {
    if (message.command === "pause") {
      if (player) {
        player.pause();
      } else if (playPauseButton && playing) {
        clickButton(playPauseButton);
      }
      reportState("extension-pause", true);
    } else if (message.command === "play") {
      if (player) {
        await player.play();
      } else if (playPauseButton && !playing) {
        clickButton(playPauseButton);
      }
      reportState("extension-play", true);
    }

    scheduleStateRefresh(`post-${message.command}`);

    extensionApi.runtime.sendMessage({
      type: "player-command-result",
      playerId,
      command: message.command,
      token: message.token,
      ok: true
    }).catch(() => undefined);
  } catch (error) {
    expectedCommandTokens.delete(message.token);
    if (message.command === "play") {
      currentAutoPauseToken = null;
    }

    extensionApi.runtime.sendMessage({
      type: "player-command-result",
      playerId,
      command: message.command,
      token: message.token,
      ok: false,
      error: String(error)
    }).catch(() => undefined);
  }
}

extensionApi.runtime.onMessage.addListener((message) => {
  if (message?.type !== "player-command") {
    return undefined;
  }

  void runCommand(message);
  return undefined;
});

scanMedia();
observeDom();
registerInteractionCancellation();
if (detectPlayerId() === "spotify") {
  setInterval(() => {
    reportState("spotify-poll");
  }, 1000);
}
window.addEventListener("pageshow", () => reportState("pageshow", true));
window.addEventListener("focus", () => reportState("focus"));
