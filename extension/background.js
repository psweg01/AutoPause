const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_RESUME_DELAY_MS = 1500;
const COMPETITOR_TTL_MS = 5000;
const DEFAULT_MAIN_PLAYER_ID = "youtubeMusic";

const PLAYER_CONFIGS = {
  youtubeMusic: {
    id: "youtubeMusic",
    label: "YouTube Music",
    origin: "https://music.youtube.com/",
    matchPattern: "https://music.youtube.com/*"
  },
  spotify: {
    id: "spotify",
    label: "Spotify",
    origin: "https://open.spotify.com/",
    matchPattern: "https://open.spotify.com/*"
  }
};

const runtimeState = {
  enabled: true,
  resumeDelayMs: DEFAULT_RESUME_DELAY_MS,
  mainPlayerId: DEFAULT_MAIN_PLAYER_ID,
  managedPlayerTabId: null,
  playerTabs: new Map(),
  competitors: new Map(),
  autoPauseSession: null,
  resumeTimer: null,
  staleSweepTimer: null
};

function token() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePlayerId(playerId) {
  return PLAYER_CONFIGS[playerId] ? playerId : DEFAULT_MAIN_PLAYER_ID;
}

function playerConfig(playerId = runtimeState.mainPlayerId) {
  return PLAYER_CONFIGS[normalizePlayerId(playerId)];
}

function availablePlayers() {
  return Object.values(PLAYER_CONFIGS).map(({ id, label }) => ({ id, label }));
}

function getPlayerIdForUrl(url) {
  for (const config of Object.values(PLAYER_CONFIGS)) {
    if (url?.startsWith(config.origin)) {
      return config.id;
    }
  }

  return null;
}

function safeOriginFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch (_error) {
    return "";
  }
}

async function loadSettings() {
  const stored = await extensionApi.storage.local.get({
    enabled: true,
    resumeDelayMs: DEFAULT_RESUME_DELAY_MS,
    mainPlayerId: DEFAULT_MAIN_PLAYER_ID
  });

  runtimeState.enabled = stored.enabled;
  runtimeState.resumeDelayMs = Number.isFinite(stored.resumeDelayMs)
    ? stored.resumeDelayMs
    : DEFAULT_RESUME_DELAY_MS;
  runtimeState.mainPlayerId = normalizePlayerId(stored.mainPlayerId);
}

async function saveEnabled(enabled) {
  runtimeState.enabled = enabled;
  await extensionApi.storage.local.set({ enabled });

  if (!enabled) {
    cancelResumeTimer();
    runtimeState.autoPauseSession = null;
  }
}

async function saveMainPlayerId(mainPlayerId) {
  runtimeState.mainPlayerId = normalizePlayerId(mainPlayerId);
  runtimeState.autoPauseSession = null;
  cancelResumeTimer();
  await extensionApi.storage.local.set({ mainPlayerId: runtimeState.mainPlayerId });
}

function cancelResumeTimer() {
  if (runtimeState.resumeTimer !== null) {
    clearTimeout(runtimeState.resumeTimer);
    runtimeState.resumeTimer = null;
  }
}

function scheduleStaleSweep() {
  if (runtimeState.staleSweepTimer !== null) {
    clearTimeout(runtimeState.staleSweepTimer);
  }

  runtimeState.staleSweepTimer = setTimeout(() => {
    runtimeState.staleSweepTimer = null;
    const removed = pruneStaleCompetitors();
    if (removed > 0) {
      evaluateCompetitorState("stale-sweep");
    }
  }, COMPETITOR_TTL_MS + 250);
}

function makeSourceId(message, sender) {
  return sender.documentId ?? message.sourceId ?? `${sender.tab?.id ?? "tab"}:${sender.frameId ?? 0}`;
}

function pruneStaleCompetitors() {
  const now = Date.now();
  let removed = 0;

  for (const [sourceId, entry] of runtimeState.competitors.entries()) {
    if (!entry.active) {
      continue;
    }

    if (now - entry.lastSeenAt > COMPETITOR_TTL_MS) {
      runtimeState.competitors.delete(sourceId);
      removed += 1;
    }
  }

  return removed;
}

function activeCompetitorEntries() {
  pruneStaleCompetitors();
  return [...runtimeState.competitors.values()].filter((entry) => entry.active);
}

function isManagedPlayerTab(tabId) {
  return runtimeState.managedPlayerTabId !== null && runtimeState.managedPlayerTabId === tabId;
}

function getManagedPlayerState() {
  if (runtimeState.managedPlayerTabId === null) {
    return null;
  }

  return runtimeState.playerTabs.get(runtimeState.managedPlayerTabId) ?? null;
}

function chooseManagedPlayerTab() {
  let bestPlaying = null;
  let bestRecent = null;

  for (const [tabId, state] of runtimeState.playerTabs.entries()) {
    if (state.playerId !== runtimeState.mainPlayerId) {
      continue;
    }

    const config = playerConfig(state.playerId);
    if (!state.url?.startsWith(config.origin)) {
      continue;
    }

    const lastPlayingAt = state.lastPlayingAt ?? 0;
    const lastRelevantAt = state.lastPlayingAt ?? state.lastUpdateAt ?? 0;

    if (state.playing) {
      const bestPlayingAt = bestPlaying?.state.lastPlayingAt ?? 0;
      if (bestPlaying === null || lastPlayingAt > bestPlayingAt) {
        bestPlaying = { tabId, state };
      }
      continue;
    }

    const bestRecentAt = bestRecent?.state.lastPlayingAt ?? bestRecent?.state.lastUpdateAt ?? 0;
    if (bestRecent === null || lastRelevantAt > bestRecentAt) {
      bestRecent = { tabId, state };
    }
  }

  runtimeState.managedPlayerTabId = bestPlaying?.tabId ?? bestRecent?.tabId ?? null;
}

async function sendPlayerCommand(command, customToken = token()) {
  const tabId = runtimeState.managedPlayerTabId;
  if (tabId === null) {
    return { ok: false, reason: "no-managed-tab" };
  }

  try {
    await extensionApi.tabs.sendMessage(tabId, {
      type: "player-command",
      command,
      token: customToken
    });
    return { ok: true, token: customToken };
  } catch (error) {
    if (command === "pause" || command === "play") {
      runtimeState.autoPauseSession = null;
      cancelResumeTimer();
    }
    return { ok: false, reason: String(error) };
  }
}

async function maybePauseManagedPlayer(reason) {
  if (!runtimeState.enabled || runtimeState.autoPauseSession !== null) {
    return;
  }

  const managedState = getManagedPlayerState();
  if (!managedState?.playing) {
    return;
  }

  const pauseToken = token();
  runtimeState.autoPauseSession = {
    tabId: runtimeState.managedPlayerTabId,
    pauseToken,
    pausedAt: Date.now(),
    cancelled: false,
    resumeIssued: false,
    reason
  };

  const result = await sendPlayerCommand("pause", pauseToken);
  if (!result.ok) {
    runtimeState.autoPauseSession = null;
  }
}

async function maybeResumeManagedPlayer(reason) {
  const session = runtimeState.autoPauseSession;
  if (!runtimeState.enabled || session === null || session.cancelled || session.resumeIssued) {
    return;
  }

  if (runtimeState.managedPlayerTabId !== session.tabId) {
    runtimeState.autoPauseSession = null;
    return;
  }

  const activeCompetitors = activeCompetitorEntries();
  if (activeCompetitors.length > 0) {
    return;
  }

  session.resumeIssued = true;
  const playToken = token();
  const result = await sendPlayerCommand("play", playToken);

  if (!result.ok) {
    runtimeState.autoPauseSession = null;
    return;
  }

  runtimeState.autoPauseSession = {
    ...session,
    resumeIssued: true,
    resumeToken: playToken,
    resumeReason: reason
  };
}

function scheduleResume(reason) {
  cancelResumeTimer();
  runtimeState.resumeTimer = setTimeout(() => {
    runtimeState.resumeTimer = null;
    void maybeResumeManagedPlayer(reason);
  }, runtimeState.resumeDelayMs);
}

function evaluateCompetitorState(reason) {
  const activeCompetitors = activeCompetitorEntries();

  if (activeCompetitors.length > 0) {
    cancelResumeTimer();
    void maybePauseManagedPlayer(reason);
    return;
  }

  scheduleResume(reason);
}

function removeCompetitorsForTab(tabId) {
  for (const [sourceId, entry] of runtimeState.competitors.entries()) {
    if (entry.tabId === tabId) {
      runtimeState.competitors.delete(sourceId);
    }
  }
}

function setCompetitorEntry(entry) {
  if (!entry.active) {
    runtimeState.competitors.delete(entry.sourceId);
    return;
  }

  runtimeState.competitors.set(entry.sourceId, entry);
  scheduleStaleSweep();
}

function syncPlayerTabCompetitorState(state) {
  const sourceId = `player-tab:${state.tabId}`;

  if (state.playerId === runtimeState.mainPlayerId) {
    runtimeState.competitors.delete(sourceId);
    return;
  }

  setCompetitorEntry({
    sourceId,
    tabId: state.tabId,
    frameId: 0,
    url: state.url ?? "",
    origin: safeOriginFromUrl(state.url),
    active: Boolean(state.playing),
    lastSeenAt: Date.now()
  });
}

function syncAllPlayerCompetitors() {
  for (const state of runtimeState.playerTabs.values()) {
    syncPlayerTabCompetitorState(state);
  }
}

function handleCompetitorState(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }

  if (isManagedPlayerTab(tabId)) {
    return;
  }

  const sourceId = makeSourceId(message, sender);
  const entry = {
    sourceId,
    tabId,
    frameId: sender.frameId ?? 0,
    url: message.url ?? sender.url ?? sender.tab?.url ?? "",
    origin: message.origin ?? "",
    active: Boolean(message.active),
    lastSeenAt: Date.now()
  };

  setCompetitorEntry(entry);
  evaluateCompetitorState("competitor-state");
}

function handlePlayerState(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }

  const playerId = normalizePlayerId(message.playerId ?? getPlayerIdForUrl(message.url ?? sender.url ?? sender.tab?.url ?? ""));
  const current = runtimeState.playerTabs.get(tabId) ?? {};
  const next = {
    ...current,
    tabId,
    playerId,
    url: message.url ?? sender.url ?? sender.tab?.url ?? "",
    playing: Boolean(message.playing),
    currentTime: Number.isFinite(message.currentTime) ? message.currentTime : 0,
    lastCause: message.cause ?? "user-or-page",
    lastToken: message.token ?? null,
    lastUpdateAt: Date.now(),
    lastPlayingAt: message.playing ? Date.now() : current.lastPlayingAt ?? null
  };

  runtimeState.playerTabs.set(tabId, next);
  chooseManagedPlayerTab();
  syncPlayerTabCompetitorState(next);

  const session = runtimeState.autoPauseSession;
  if (session !== null && tabId === session.tabId && playerId === runtimeState.mainPlayerId) {
    if (message.cause === "extension" && message.token === session.pauseToken && !message.playing) {
      session.pauseConfirmedAt = Date.now();
    }

    if (message.cause === "extension" && message.token === session.resumeToken && message.playing) {
      runtimeState.autoPauseSession = null;
    }

    if (message.cause !== "extension" && message.playing) {
      runtimeState.autoPauseSession = null;
      cancelResumeTimer();
    }
  }

  if (message.playing || playerId !== runtimeState.mainPlayerId) {
    evaluateCompetitorState("player-state");
  }
}

function handlePlayerUserInteraction(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || runtimeState.autoPauseSession === null) {
    return;
  }

  if (tabId !== runtimeState.autoPauseSession.tabId) {
    return;
  }

  if (message.token && message.token === runtimeState.autoPauseSession.pauseToken) {
    runtimeState.autoPauseSession.cancelled = true;
    cancelResumeTimer();
  }
}

function handlePlayerCommandResult(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || runtimeState.autoPauseSession === null) {
    return;
  }

  if (tabId !== runtimeState.autoPauseSession.tabId) {
    return;
  }

  if (message.ok === false) {
    runtimeState.autoPauseSession = null;
    cancelResumeTimer();
  }
}

async function handlePopupGetStatus() {
  const selectedPlayer = playerConfig();
  return {
    enabled: runtimeState.enabled,
    mainPlayerId: runtimeState.mainPlayerId,
    mainPlayerLabel: selectedPlayer.label,
    managedPlayerFound: runtimeState.managedPlayerTabId !== null,
    managedPlayerTabId: runtimeState.managedPlayerTabId,
    competingAudioActive: activeCompetitorEntries().length > 0,
    availablePlayers: availablePlayers()
  };
}

async function handlePopupSetEnabled(message) {
  await saveEnabled(Boolean(message.enabled));
  if (runtimeState.enabled) {
    evaluateCompetitorState("popup-toggle");
  } else {
    cancelResumeTimer();
  }
  return handlePopupGetStatus();
}

async function handlePopupSetMainPlayer(message) {
  await saveMainPlayerId(message.mainPlayerId);
  chooseManagedPlayerTab();
  syncAllPlayerCompetitors();
  if (runtimeState.enabled) {
    evaluateCompetitorState("main-player-changed");
  }
  return handlePopupGetStatus();
}

async function requestPlayerState(tabId) {
  try {
    await extensionApi.tabs.sendMessage(tabId, {
      type: "player-command",
      command: "state-request",
      token: token()
    });
  } catch (_error) {
    return;
  }
}

async function bootstrapPlayerTabs() {
  try {
    const tabs = await extensionApi.tabs.query({
      url: Object.values(PLAYER_CONFIGS).map((config) => config.matchPattern)
    });

    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) {
          return;
        }

        await requestPlayerState(tab.id);
      })
    );
  } catch (_error) {
    return;
  }
}

extensionApi.runtime.onInstalled.addListener(() => {
  void loadSettings().then(() => {
    chooseManagedPlayerTab();
    syncAllPlayerCompetitors();
  });
  void bootstrapPlayerTabs();
});

extensionApi.runtime.onStartup?.addListener(() => {
  void loadSettings().then(() => {
    chooseManagedPlayerTab();
    syncAllPlayerCompetitors();
  });
  void bootstrapPlayerTabs();
});

extensionApi.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case "competitor-media-state":
      handleCompetitorState(message, sender);
      return undefined;
    case "player-state":
      handlePlayerState(message, sender);
      return undefined;
    case "player-user-interaction":
      handlePlayerUserInteraction(message, sender);
      return undefined;
    case "player-command-result":
      handlePlayerCommandResult(message, sender);
      return undefined;
    case "popup-get-status":
      return handlePopupGetStatus();
    case "popup-set-enabled":
      return handlePopupSetEnabled(message);
    case "popup-set-main-player":
      return handlePopupSetMainPlayer(message);
    default:
      return undefined;
  }
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  runtimeState.playerTabs.delete(tabId);
  removeCompetitorsForTab(tabId);

  if (runtimeState.managedPlayerTabId === tabId) {
    runtimeState.managedPlayerTabId = null;
  }

  if (runtimeState.autoPauseSession?.tabId === tabId) {
    runtimeState.autoPauseSession = null;
    cancelResumeTimer();
  }

  chooseManagedPlayerTab();
  evaluateCompetitorState("tab-removed");
});

extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const nextPlayerId = getPlayerIdForUrl(changeInfo.url);
    if (!nextPlayerId) {
      runtimeState.playerTabs.delete(tabId);
      removeCompetitorsForTab(tabId);
      if (runtimeState.managedPlayerTabId === tabId) {
        runtimeState.managedPlayerTabId = null;
      }
      chooseManagedPlayerTab();
      evaluateCompetitorState("tab-url-changed");
      return;
    }
  }

  if (changeInfo.status === "complete") {
    const playerId = getPlayerIdForUrl(tab.url ?? changeInfo.url ?? "");
    if (playerId) {
      void requestPlayerState(tabId);
    }
  }
});

void loadSettings().then(() => {
  chooseManagedPlayerTab();
  syncAllPlayerCompetitors();
});
void bootstrapPlayerTabs();
