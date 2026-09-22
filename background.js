// Event-driven only: opens the setup page once, after install. No persistent
// state and no long-lived connection, so Manifest V3's aggressive service
// worker termination is harmless here.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

chrome.action.onClicked?.addListener?.(() => {});
