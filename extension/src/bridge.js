/*
 * BlindReplay bridge. Runs in the extension's isolated world.
 * - Loads and saves panel settings with chrome.storage.local (on this device only).
 * - Tells the page script to restore everything if the extension is disabled,
 *   removed or reloaded while the tab stays open.
 */
(function () {
  'use strict';
  if (window.top !== window) return;

  const KEY = 'blindReplaySettings';
  let alive = true;

  function toPage(msg) {
    document.dispatchEvent(new CustomEvent('blindreplay:to-page', { detail: JSON.stringify(msg) }));
  }

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function sendSettings() {
    if (!extensionAlive()) return;
    chrome.storage.local.get(KEY, (res) => {
      if (chrome.runtime.lastError) return;
      const s = res && res[KEY];
      if (s && typeof s === 'object') toPage({ type: 'settings', settings: s });
    });
  }

  document.addEventListener('blindreplay:to-ext', (ev) => {
    if (!alive) return;
    let msg;
    try {
      msg = JSON.parse(ev.detail);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!extensionAlive()) return shutdown();
    if (msg.type === 'hello') sendSettings();
    else if (msg.type === 'save' && msg.settings && typeof msg.settings === 'object') {
      chrome.storage.local.set({ [KEY]: msg.settings }, () => void chrome.runtime.lastError);
    }
  });

  function shutdown() {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    toPage({ type: 'teardown' });
  }

  // When the extension is disabled or reloaded, this script is orphaned and
  // chrome.runtime.id disappears. Restore the page in that case.
  const timer = setInterval(() => {
    if (!extensionAlive()) shutdown();
  }, 1000);

  // Toolbar button: show/hide the panel.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'toggle-panel') toPage({ type: 'toggle-panel' });
    });
  } catch (_) {
    /* extension context gone */
  }

  sendSettings();
})();
