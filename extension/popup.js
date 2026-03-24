const extensionApi = globalThis.browser ?? globalThis.chrome;

const enabledInput = document.getElementById("enabled");
const statusNode = document.getElementById("status");

function renderStatus(status) {
  enabledInput.checked = Boolean(status.enabled);

  const ytmText = status.managedYtmFound ? "Managed YTM tab found" : "No active YTM tab";
  const audioText = status.competingAudioActive ? "Competing audio active" : "Competing audio idle";
  statusNode.textContent = `${ytmText}. ${audioText}.`;
}

async function fetchStatus() {
  const status = await extensionApi.runtime.sendMessage({ type: "popup-get-status" });
  renderStatus(status);
}

enabledInput.addEventListener("change", async () => {
  const status = await extensionApi.runtime.sendMessage({
    type: "popup-set-enabled",
    enabled: enabledInput.checked
  });
  renderStatus(status);
});

void fetchStatus();
