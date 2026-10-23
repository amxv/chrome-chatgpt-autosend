"use strict";

// Chrome labels custom site searches as "keyword". "generated" also denotes
// an omnibox-generated search suggestion, not a link or window.open.
const OMNIBOX_TRANSITIONS = new Set(["keyword", "generated"]);
const APPROVAL_TTL_MS = 30000;
const APPROVAL_WAIT_ATTEMPTS = 20;
const APPROVAL_WAIT_MS = 100;
const pendingApprovals = new Set();
let secretPromise;
let setupOpened = false;

function getSecret() {
  if (!secretPromise) {
    secretPromise = (async () => {
      // Content scripts must not be able to read the stored secret.
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const { autosendSecret } = await chrome.storage.local.get("autosendSecret");
      if (typeof autosendSecret === "string" && /^[0-9a-f]{32}$/.test(autosendSecret)) {
        return { secret: autosendSecret, created: false };
      }

      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      await chrome.storage.local.set({ autosendSecret: secret });
      return { secret, created: true };
    })().catch((error) => {
      secretPromise = undefined;
      throw error;
    });
  }
  return secretPromise;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    const { created } = await getSecret();
    // First installs and upgrades from autosend=1 require a one-time site-search
    // URL change. Never reopen setup for an ordinary update with a saved secret.
    if ((reason === "install" || created) && !setupOpened) {
      setupOpened = true;
      await chrome.runtime.openOptionsPage();
    }
  } catch (error) {
    console.error("[ChatGPT Auto-Send] Could not set up the secret:", error);
  }
});

const approvalKey = (tabId, documentId) => `approval:${tabId}:${documentId}`;

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !details.documentId ||
      !OMNIBOX_TRANSITIONS.has(details.transitionType)) return;

  const url = new URL(details.url);
  if (url.origin !== "https://chatgpt.com" || url.pathname !== "/") return;

  const secrets = url.searchParams.getAll("autosend");
  const queries = url.searchParams.getAll("q");
  if (secrets.length !== 1 || queries.length !== 1 || !queries[0].trim()) return;

  try {
    const { secret } = await getSecret();
    if (secrets[0] !== secret) return;
    // The key identifies the *document*, not merely the tab. A subsequent
    // link/redirect in the same tab cannot consume an earlier approval.
    await chrome.storage.session.set({
      [approvalKey(details.tabId, details.documentId)]: {
        at: Date.now(),
        query: queries[0].trim()
      }
    });
  } catch (error) {
    console.error("[ChatGPT Auto-Send] Could not record navigation:", error);
  }
}, { url: [{ schemes: ["https"], hostEquals: "chatgpt.com" }] });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function consumeApproval(tabId, documentId) {
  const key = approvalKey(tabId, documentId);
  // Prevent simultaneous messages for one document from both consuming the
  // same pending storage entry before either remove finishes.
  if (pendingApprovals.has(key)) return null;
  pendingApprovals.add(key);

  try {
    // onCommitted and the document_start content script race. Wait briefly for
    // the navigation event's asynchronous storage write to complete.
    for (let attempt = 0; attempt < APPROVAL_WAIT_ATTEMPTS; attempt++) {
      const { [key]: approval } = await chrome.storage.session.get(key);
      if (approval !== undefined) {
        await chrome.storage.session.remove(key);
        const age = Date.now() - approval?.at;
        if (typeof approval?.query === "string" && approval.query &&
            age >= 0 && age <= APPROVAL_TTL_MS) return approval.query;
        return null;
      }
      await delay(APPROVAL_WAIT_MS);
    }
    return null;
  } finally {
    pendingApprovals.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "autosend-get-setup" &&
      sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL("options.html")) {
    getSecret()
      .then(({ secret }) => respond({ url: `https://chatgpt.com/?q=%s&autosend=${secret}` }))
      .catch(() => respond({ error: "Could not load the setup URL. Reload this page." }));
    return true;
  }

  if (message?.type !== "autosend-approval" || sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 || !sender.tab || !sender.documentId ||
      !sender.url?.startsWith("https://chatgpt.com/")) return false;

  consumeApproval(sender.tab.id, sender.documentId)
    .then((query) => respond(query ? { approved: true, query } : { approved: false }))
    .catch(() => respond({ approved: false }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const prefix = `approval:${tabId}:`;
  const entries = await chrome.storage.session.get(null);
  const keys = Object.keys(entries).filter((key) => key.startsWith(prefix));
  if (keys.length) await chrome.storage.session.remove(keys);
});
