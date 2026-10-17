"use strict";

// Transition types Chrome reports for omnibox searches. Links, redirects and
// window.open report "link" or similar, so they never get approval.
const OMNIBOX_TRANSITIONS = new Set(["keyword", "generated"]);
const APPROVAL_TTL_MS = 30000;

const keyFor = (tabId) => `approval:${tabId}`;

chrome.webNavigation.onCommitted.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const key = keyFor(details.tabId);
    if (OMNIBOX_TRANSITIONS.has(details.transitionType)) {
      await chrome.storage.session.set({ [key]: Date.now() });
    } else {
      await chrome.storage.session.remove(key);
    }
  },
  { url: [{ hostEquals: "chatgpt.com" }] }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One-shot: the approval is consumed, so a reload or a second injection in the
// same tab cannot reuse it.
async function consumeApproval(tabId) {
  const key = keyFor(tabId);
  // onCommitted writes storage asynchronously and may land just after the
  // content script asks, so poll briefly.
  for (let i = 0; i < 10; i++) {
    const { [key]: at } = await chrome.storage.session.get(key);
    if (at) {
      await chrome.storage.session.remove(key);
      return Date.now() - at <= APPROVAL_TTL_MS;
    }
    await sleep(100);
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "autosend-approval" || sender.frameId !== 0 || !sender.tab) {
    return false;
  }
  consumeApproval(sender.tab.id).then((approved) => sendResponse({ approved }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId));
});
