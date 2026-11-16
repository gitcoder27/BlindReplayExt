// Toolbar button: show or hide the BlindReplay panel on the current Dhan tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }, () => void chrome.runtime.lastError);
});
