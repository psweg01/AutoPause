const extensionApi = globalThis.browser ?? globalThis.chrome;

const enabledInput = document.getElementById("enabled");
const mainPlayerSelect = document.getElementById("main-player");
const statusNode = document.getElementById("status");

function renderPlayerOptions(status) {
  const currentValue = status.mainPlayerId;

  mainPlayerSelect.replaceChildren(
    ...status.availablePlayers.map((player) => {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = player.label;
      return option;
    })
  );

  mainPlayerSelect.value = currentValue;
}

function renderStatus(status) {
  enabledInput.checked = Boolean(status.enabled);
  renderPlayerOptions(status);

  const playerText = status.managedPlayerFound
    ? `Managed ${status.mainPlayerLabel} tab found`
    : `No active ${status.mainPlayerLabel} tab`;
  const audioText = status.competingAudioActive ? "Competing audio active" : "Competing audio idle";
  statusNode.textContent = `${playerText}. ${audioText}.`;
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

mainPlayerSelect.addEventListener("change", async () => {
  const status = await extensionApi.runtime.sendMessage({
    type: "popup-set-main-player",
    mainPlayerId: mainPlayerSelect.value
  });
  renderStatus(status);
});

void fetchStatus();
