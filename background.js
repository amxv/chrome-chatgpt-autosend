"use strict";

// Dia reports custom site searches as "typed" (confirmed in its History
// transition records). Other Chromium browsers may use "keyword" or
// "generated". All three mean a browser/omnibox-initiated navigation, not a
// website link or window.open.
const OMNIBOX_TRANSITIONS = new Set(["typed", "keyword", "generated"]);
const APPROVAL_TTL_MS = 30000;
const APPROVAL_WAIT_ATTEMPTS = 20;
const APPROVAL_WAIT_MS = 100;
const HANDOFF_TTL_MS = 10000;
const pendingApprovals = new Set();
const pendingHandoffs = new Set();
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
const handoffKey = (tabId) => `handoff:${tabId}`;

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validAge(at, ttl) {
  const age = Date.now() - at;
  return age >= 0 && age <= ttl;
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !details.documentId) return;

  const url = new URL(details.url);
  if (url.origin !== "https://chatgpt.com" || !["/", "/work"].includes(url.pathname)) return;

  const secrets = url.searchParams.getAll("autosend");
  const queries = url.searchParams.getAll("q");
  if (secrets.length !== 1 || queries.length !== 1 || !queries[0].trim()) return;

  try {
    const { secret } = await getSecret();
    if (secrets[0] !== secret) return;

    // A legacy site-search URL points at / instead of /work. After that
    // original omnibox navigation is approved, the content script redirects
    // once to /work with a short-lived, tab-bound ticket. This exception must
    // NOT make arbitrary link/redirect navigations eligible for auto-send.
    const tickets = url.searchParams.getAll("autosend_handoff");
    if (tickets.length) {
      if (url.pathname !== "/work" || tickets.length !== 1) return;
      const key = handoffKey(details.tabId);
      if (pendingHandoffs.has(key)) return;
      pendingHandoffs.add(key);
      try {
        const { [key]: handoff } = await chrome.storage.session.get(key);
        if (!handoff || handoff.ticket !== tickets[0] ||
            handoff.query !== queries[0].trim() ||
            handoff.fromDocumentId === details.documentId ||
            !validAge(handoff.at, HANDOFF_TTL_MS)) return;
        await chrome.storage.session.remove(key);
      } finally {
        pendingHandoffs.delete(key);
      }
    } else {
      if (!OMNIBOX_TRANSITIONS.has(details.transitionType)) return;
      // Dia uses typed + from_address_bar. Chrome uses keyword/generated.
      if (details.transitionType === "typed" &&
          !details.transitionQualifiers?.includes("from_address_bar")) return;
      if (details.transitionQualifiers?.some((qualifier) =>
        qualifier === "server_redirect" || qualifier === "client_redirect")) return;
    }

    // The key identifies the *document*, not merely the tab. A subsequent
    // unapproved link/redirect cannot consume another document's approval.
    await chrome.storage.session.set({
      [approvalKey(details.tabId, details.documentId)]: {
        at: Date.now(),
        query: queries[0].trim(),
        pathname: url.pathname
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
        if (typeof approval?.query === "string" && approval.query &&
            validAge(approval.at, APPROVAL_TTL_MS)) return approval;
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
      .then(({ secret }) => respond({ url: `https://chatgpt.com/work?q=%s&autosend=${secret}` }))
      .catch(() => respond({ error: "Could not load the setup URL. Reload this page." }));
    return true;
  }

  if (message?.type !== "autosend-approval" || sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 || !sender.tab || !sender.documentId ||
      !sender.url?.startsWith("https://chatgpt.com/")) return false;

  consumeApproval(sender.tab.id, sender.documentId)
    .then(async (approval) => {
      if (!approval) return respond({ approved: false });
      const { query } = approval;

      if (approval.pathname !== "/") return respond({ approved: true, query });

      // Transparently migrate existing /?q=... shortcuts without requiring a
      // browser-settings change. The redirect can only be authorized after a
      // genuine, one-use omnibox approval for the original document.
      const ticket = randomToken();
      const { secret } = await getSecret();
      await chrome.storage.session.set({
        [handoffKey(sender.tab.id)]: {
          ticket, query, fromDocumentId: sender.documentId, at: Date.now()
        }
      });
      const destination = new URL("https://chatgpt.com/work");
      destination.searchParams.set("q", query);
      destination.searchParams.set("autosend", secret);
      destination.searchParams.set("autosend_handoff", ticket);
      respond({ approved: true, query, redirectUrl: destination.href });
    })
    .catch(() => respond({ approved: false }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const prefix = `approval:${tabId}:`;
  const entries = await chrome.storage.session.get(null);
  const keys = Object.keys(entries).filter((key) => key.startsWith(prefix));
  if (keys.length) await chrome.storage.session.remove(keys);
  await chrome.storage.session.remove(handoffKey(tabId));
});
