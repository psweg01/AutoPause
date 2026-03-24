const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_RESUME_DELAY_MS = 1500;
const COMPETITOR_TTL_MS = 5000;

const runtimeState = {
  enabled: true,
  resumeDelayMs: DEFAULT_RESUME_DELAY_MS,
  managedYtmTabId: null,
  ytmTabs: new Map(),
  competitors: new Map(),
  autoPauseSession: null,
  resumeTimer: null,
  staleSweepTimer: null
};

function token() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadSettings() {
  const stored = await extensionApi.storage.local.get({
    enabled: true,
    resumeDelayMs: DEFAULT_RESUME_DELAY_MS
  });

  runtimeState.enabled = stored.enabled;
  runtimeState.resumeDelayMs = Number.isFinite(stored.resumeDelayMs)
    ? stored.resumeDelayMs
    : DEFAULT_RESUME_DELAY_MS;
}

async function saveEnabled(enabled) {
  runtimeState.enabled = enabled;
  await extensionApi.storage.local.set({ enabled });

  if (!enabled) {
    cancelResumeTimer();
    runtimeState.autoPauseSession = null;
  }
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

function isManagedYtmTab(tabId) {
  return runtimeState.managedYtmTabId !== null && runtimeState.managedYtmTabId === tabId;
}

function getManagedYtmState() {
  if (runtimeState.managedYtmTabId === null) {
    return null;
  }

  return runtimeState.ytmTabs.get(runtimeState.managedYtmTabId) ?? null;
}

function chooseManagedYtmTab() {
  let bestPlaying = null;
  let bestRecent = null;

  for (const [tabId, state] of runtimeState.ytmTabs.entries()) {
    if (!state.url?.startsWith("https://music.youtube.com/")) {
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

  runtimeState.managedYtmTabId = bestPlaying?.tabId ?? bestRecent?.tabId ?? null;
}

async function sendYtmCommand(command, customToken = token()) {
  const tabId = runtimeState.managedYtmTabId;
  if (tabId === null) {
    return { ok: false, reason: "no-managed-tab" };
  }

  try {
    await extensionApi.tabs.sendMessage(tabId, {
      type: "ytm-command",
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

async function maybePauseManagedYtm(reason) {
  if (!runtimeState.enabled || runtimeState.autoPauseSession !== null) {
    return;
  }

  const ytmState = getManagedYtmState();
  if (!ytmState?.playing) {
    return;
  }

  const pauseToken = token();
  runtimeState.autoPauseSession = {
    tabId: runtimeState.managedYtmTabId,
    pauseToken,
    pausedAt: Date.now(),
    cancelled: false,
    resumeIssued: false,
    reason
  };

  const result = await sendYtmCommand("pause", pauseToken);
  if (!result.ok) {
    runtimeState.autoPauseSession = null;
  }
}

async function maybeResumeManagedYtm(reason) {
  const session = runtimeState.autoPauseSession;
  if (!runtimeState.enabled || session === null || session.cancelled || session.resumeIssued) {
    return;
  }

  if (runtimeState.managedYtmTabId !== session.tabId) {
    runtimeState.autoPauseSession = null;
    return;
  }

  const activeCompetitors = activeCompetitorEntries();
  if (activeCompetitors.length > 0) {
    return;
  }

  session.resumeIssued = true;
  const playToken = token();
  const result = await sendYtmCommand("play", playToken);

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
    void maybeResumeManagedYtm(reason);
  }, runtimeState.resumeDelayMs);
}

function evaluateCompetitorState(reason) {
  const activeCompetitors = activeCompetitorEntries();

  if (activeCompetitors.length > 0) {
    cancelResumeTimer();
    void maybePauseManagedYtm(reason);
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

function handleCompetitorState(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }

  if (isManagedYtmTab(tabId)) {
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

  if (!entry.active) {
    runtimeState.competitors.delete(sourceId);
  } else {
    runtimeState.competitors.set(sourceId, entry);
    scheduleStaleSweep();
  }

  evaluateCompetitorState("competitor-state");
}

function handleYtmState(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return;
  }

  const current = runtimeState.ytmTabs.get(tabId) ?? {};
  const next = {
    ...current,
    tabId,
    url: message.url ?? sender.url ?? sender.tab?.url ?? "",
    playing: Boolean(message.playing),
    currentTime: Number.isFinite(message.currentTime) ? message.currentTime : 0,
    lastCause: message.cause ?? "user-or-page",
    lastToken: message.token ?? null,
    lastUpdateAt: Date.now(),
    lastPlayingAt: message.playing ? Date.now() : current.lastPlayingAt ?? null
  };

  runtimeState.ytmTabs.set(tabId, next);
  chooseManagedYtmTab();

  const session = runtimeState.autoPauseSession;
  if (session !== null && tabId === session.tabId) {
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

  if (message.playing) {
    evaluateCompetitorState("ytm-started-playing");
  }
}

function handleYtmUserInteraction(message, sender) {
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

function handleYtmCommandResult(message, sender) {
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
  return {
    enabled: runtimeState.enabled,
    managedYtmFound: runtimeState.managedYtmTabId !== null,
    managedYtmTabId: runtimeState.managedYtmTabId,
    competingAudioActive: activeCompetitorEntries().length > 0
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

async function bootstrapYtmTabs() {
  try {
    const tabs = await extensionApi.tabs.query({ url: ["https://music.youtube.com/*"] });
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) {
          return;
        }

        try {
          await extensionApi.tabs.sendMessage(tab.id, {
            type: "ytm-command",
            command: "state-request",
            token: token()
          });
        } catch (_error) {
          return;
        }
      })
    );
  } catch (_error) {
    return;
  }
}

extensionApi.runtime.onInstalled.addListener(() => {
  void loadSettings();
  void bootstrapYtmTabs();
});

extensionApi.runtime.onStartup?.addListener(() => {
  void loadSettings();
  void bootstrapYtmTabs();
});

extensionApi.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case "competitor-media-state":
      handleCompetitorState(message, sender);
      return undefined;
    case "ytm-state":
      handleYtmState(message, sender);
      return undefined;
    case "ytm-user-interaction":
      handleYtmUserInteraction(message, sender);
      return undefined;
    case "ytm-command-result":
      handleYtmCommandResult(message, sender);
      return undefined;
    case "popup-get-status":
      return handlePopupGetStatus();
    case "popup-set-enabled":
      return handlePopupSetEnabled(message);
    default:
      return undefined;
  }
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  runtimeState.ytmTabs.delete(tabId);
  removeCompetitorsForTab(tabId);

  if (runtimeState.managedYtmTabId === tabId) {
    runtimeState.managedYtmTabId = null;
  }

  if (runtimeState.autoPauseSession?.tabId === tabId) {
    runtimeState.autoPauseSession = null;
    cancelResumeTimer();
  }

  chooseManagedYtmTab();
  evaluateCompetitorState("tab-removed");
});

extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !changeInfo.url.startsWith("https://music.youtube.com/")) {
    runtimeState.ytmTabs.delete(tabId);
    if (runtimeState.managedYtmTabId === tabId) {
      runtimeState.managedYtmTabId = null;
    }
    chooseManagedYtmTab();
  }

  if (changeInfo.status === "complete" && tab.url?.startsWith("https://music.youtube.com/")) {
    void extensionApi.tabs.sendMessage(tabId, {
      type: "ytm-command",
      command: "state-request",
      token: token()
    }).catch(() => undefined);
  }
});

void loadSettings();
void bootstrapYtmTabs();
