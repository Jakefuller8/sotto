// Event-driven only: opens the setup page once after install, and re-derives
// the shared key when a content script finds it stale. No persistent state and
// no long-lived connection, so Manifest V3's aggressive service worker
// termination is harmless here.

// Pairing lives in pair.js, shared with the popup and the onboarding page. The
// content script cannot do this itself — it has no access to the derivation —
// and duplicating the crypto here would let the two copies drift apart.
importScripts("pair.js");

// The origins content.js is declared for. Kept in step with the
// content_scripts matches in manifest.json.
const CHAT_ORIGINS = [
  "https://claude.ai/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://aistudio.google.com/*",
  "https://www.perplexity.ai/*",
];

// Declared content scripts only run when a page loads. So installing,
// updating, or reloading the extension leaves every already-open chat tab
// with no content script — or, after an update, an orphaned one whose
// extension context has been invalidated. Either way the pill never appears
// and the user is told to reload the tab, which is a support ticket rather
// than a product.
//
// Injecting into the matching tabs that are already open closes that gap.
// content.js guards against running twice, so a tab that already has a live
// script is unaffected.
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: CHAT_ORIGINS });
  } catch {
    return;
  }

  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
        // A tab can be discarded, mid-navigation, or otherwise not scriptable.
        // One failure must not stop the others.
        .catch(() => {})
    )
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  injectIntoOpenTabs();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

// Covers a browser restart, where the worker starts before any chat tab has
// finished restoring.
chrome.runtime.onStartup.addListener(() => {
  injectIntoOpenTabs();
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== "sotto-repair") return;

  // pair(false), not pair(true): re-derive against whatever public key the
  // phone currently has published, while keeping our own keypair. Rotating
  // ours would invalidate the phone's key in turn and the two would chase each
  // other. The laptop is the only side that decrypts, so healing here is
  // enough to recover the whole link.
  SottoPair.pair(false)
    .then((sas) => respond({ ok: !!sas, sas: sas || null }))
    .catch(() => respond({ ok: false, sas: null }));

  return true; // respond asynchronously
});

chrome.action.onClicked?.addListener?.(() => {});
