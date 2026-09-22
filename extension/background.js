// Event-driven only: opens the setup page once after install, and re-derives
// the shared key when a content script finds it stale. No persistent state and
// no long-lived connection, so Manifest V3's aggressive service worker
// termination is harmless here.

// Pairing lives in pair.js, shared with the popup and the onboarding page. The
// content script cannot do this itself — it has no access to the derivation —
// and duplicating the crypto here would let the two copies drift apart.
importScripts("pair.js");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
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
