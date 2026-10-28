const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const SECRET = "abcdef0123456789abcdef0123456789";
const source = readFileSync(join(__dirname, "..", "background.js"), "utf8");

function makeWorker({ secret = SECRET } = {}) {
  const local = new Map(secret ? [["autosendSecret", secret]] : []);
  const session = new Map();
  const listeners = {};
  let now = 50000;
  let optionsOpened = 0;
  let localAccessLevel;
  const id = "extension-test";

  function getEntries(store, keys) {
    if (keys === null) return Object.fromEntries(store);
    if (typeof keys === "string") return store.has(keys) ? { [keys]: store.get(keys) } : {};
    return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
  }

  const chrome = {
    runtime: {
      id,
      getURL: (name) => `chrome-extension://${id}/${name}`,
      openOptionsPage: async () => { optionsOpened++; },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } }
    },
    webNavigation: { onCommitted: { addListener: (fn) => { listeners.committed = fn; } } },
    tabs: { onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } } },
    storage: {
      local: {
        setAccessLevel: async ({ accessLevel }) => { localAccessLevel = accessLevel; },
        get: async (keys) => getEntries(local, keys),
        set: async (entries) => { Object.entries(entries).forEach(([k, v]) => local.set(k, v)); }
      },
      session: {
        get: async (keys) => getEntries(session, keys),
        set: async (entries) => { Object.entries(entries).forEach(([k, v]) => session.set(k, v)); },
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key);
        }
      }
    }
  };

  vm.runInNewContext(source, {
    chrome,
    crypto: webcrypto,
    URL,
    Uint8Array,
    console: { error() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback) => setImmediate(callback)
  });

  const target = ({ q = "test prompt", token = SECRET } = {}) =>
    `https://chatgpt.com/work?q=${encodeURIComponent(q)}&autosend=${token}`;

  async function nav({
    tabId = 1,
    documentId = "document-a",
    frameId = 0,
    transitionType = "keyword",
    transitionQualifiers = [],
    q = "test prompt",
    token = SECRET,
    url = target({ q, token })
  } = {}) {
    await listeners.committed({ tabId, documentId, frameId, transitionType, transitionQualifiers, url });
  }

  function message({
    type = "autosend-approval",
    tabId = 1,
    documentId = "document-a",
    frameId = 0,
    senderId = id,
    senderUrl = target()
  } = {}) {
    return new Promise((resolve) => {
      const keepAlive = listeners.message(
        { type },
        { id: senderId, tab: { id: tabId }, documentId, frameId, url: senderUrl },
        resolve
      );
      if (!keepAlive) resolve({ approved: false });
    });
  }

  return {
    nav,
    message,
    install: (reason) => listeners.installed({ reason }),
    closeTab: (tabId) => listeners.tabRemoved(tabId),
    advance: (ms) => { now += ms; },
    getSecret: () => local.get("autosendSecret"),
    getOptionsOpened: () => optionsOpened,
    getLocalAccessLevel: () => localAccessLevel,
    getSessionKeys: () => [...session.keys()],
    getSetupUrl: () => message({ type: "autosend-get-setup", senderUrl: chrome.runtime.getURL("options.html") })
  };
}

test("generates a 128-bit secret automatically and opens one-time setup", async () => {
  const worker = makeWorker({ secret: null });
  await worker.install("install");
  assert.match(worker.getSecret(), /^[0-9a-f]{32}$/);
  assert.equal(worker.getOptionsOpened(), 1);
  assert.equal(worker.getLocalAccessLevel(), "TRUSTED_CONTEXTS");

  const setup = await worker.getSetupUrl();
  assert.equal(setup.url, `https://chatgpt.com/work?q=%s&autosend=${worker.getSecret()}`);
});

test("upgrade from autosend=1 opens setup only when a new secret is needed", async () => {
  const worker = makeWorker({ secret: null });
  await worker.install("update");
  assert.equal(worker.getOptionsOpened(), 1);
  await worker.install("update");
  assert.equal(worker.getOptionsOpened(), 1);
});

test("an existing secret survives updates without reopening setup", async () => {
  const worker = makeWorker();
  await worker.install("update");
  assert.equal(worker.getSecret(), SECRET);
  assert.equal(worker.getOptionsOpened(), 0);
});

test("an omnibox keyword navigation is approved exactly once", async () => {
  const worker = makeWorker();
  await worker.nav({ q: "send this" });
  const first = await worker.message();
  const replay = await worker.message();
  assert.equal(first.approved, true);
  assert.equal(first.query, "send this");
  assert.equal(replay.approved, false);
});

test("legacy / site-search shortcut securely redirects to /work and approves it once", async () => {
  const worker = makeWorker();
  const legacyUrl = `https://chatgpt.com/?q=existing%20shortcut&autosend=${SECRET}`;
  await worker.nav({ url: legacyUrl, documentId: "legacy-document" });
  const legacy = await worker.message({ senderUrl: legacyUrl, documentId: "legacy-document" });
  assert.equal(legacy.approved, true);
  assert.equal(legacy.query, "existing shortcut");
  const destination = new URL(legacy.redirectUrl);
  assert.equal(destination.pathname, "/work");
  assert.equal(destination.searchParams.get("q"), "existing shortcut");
  assert.equal(destination.searchParams.get("autosend"), SECRET);
  assert.match(destination.searchParams.get("autosend_handoff"), /^[a-f0-9]{32}$/);

  // A legitimate location.replace looks like a client redirect, which is
  // allowed only with this single-use, tab-bound handoff ticket.
  await worker.nav({
    url: legacy.redirectUrl,
    documentId: "work-document",
    transitionType: "link",
    transitionQualifiers: ["client_redirect"]
  });
  const approval = await worker.message({ senderUrl: legacy.redirectUrl, documentId: "work-document" });
  assert.equal(approval.approved, true);
  assert.equal(approval.query, "existing shortcut");
  assert.equal((await worker.message({ senderUrl: legacy.redirectUrl, documentId: "work-document" })).approved, false);
});

test("a handoff is tab-bound and cannot be replayed, forged, or reused on another path", async () => {
  const worker = makeWorker();
  const legacyUrl = `https://chatgpt.com/?q=hello&autosend=${SECRET}`;
  await worker.nav({ url: legacyUrl, documentId: "legacy-document" });
  const { redirectUrl } = await worker.message({ senderUrl: legacyUrl, documentId: "legacy-document" });

  const forged = new URL(redirectUrl);
  forged.searchParams.set("autosend_handoff", "ffffffffffffffffffffffffffffffff");
  await worker.nav({ url: forged.href, documentId: "forged" });
  assert.equal((await worker.message({ documentId: "forged" })).approved, false);

  await worker.nav({ url: redirectUrl, tabId: 2, documentId: "other-tab" });
  assert.equal((await worker.message({ tabId: 2, documentId: "other-tab" })).approved, false);

  const wrongQuery = new URL(redirectUrl);
  wrongQuery.searchParams.set("q", "different prompt");
  await worker.nav({ url: wrongQuery.href, documentId: "wrong-query" });
  assert.equal((await worker.message({ documentId: "wrong-query" })).approved, false);

  const wrongPath = new URL(redirectUrl);
  wrongPath.pathname = "/";
  await worker.nav({ url: wrongPath.href, documentId: "wrong-path" });
  assert.equal((await worker.message({ documentId: "wrong-path" })).approved, false);

  await worker.nav({ url: redirectUrl, documentId: "work-document" });
  assert.equal((await worker.message({ documentId: "work-document" })).approved, true);

  await worker.nav({ url: redirectUrl, documentId: "replay" });
  assert.equal((await worker.message({ documentId: "replay" })).approved, false);
});

test("a handoff cannot authorize the original document or a late redirect", async () => {
  const worker = makeWorker();
  const legacyUrl = `https://chatgpt.com/?q=hello&autosend=${SECRET}`;
  await worker.nav({ url: legacyUrl, documentId: "original" });
  const { redirectUrl } = await worker.message({ senderUrl: legacyUrl, documentId: "original" });
  await worker.nav({ url: redirectUrl, documentId: "original", transitionType: "link" });
  assert.equal((await worker.message({ documentId: "original" })).approved, false);
  worker.advance(10001);
  await worker.nav({ url: redirectUrl, documentId: "late", transitionType: "link" });
  assert.equal((await worker.message({ documentId: "late" })).approved, false);
});

test("parallel navigations cannot reuse a single handoff ticket", async () => {
  const worker = makeWorker();
  const legacyUrl = `https://chatgpt.com/?q=hello&autosend=${SECRET}`;
  await worker.nav({ url: legacyUrl, documentId: "original" });
  const { redirectUrl } = await worker.message({ senderUrl: legacyUrl, documentId: "original" });
  await Promise.all([
    worker.nav({ url: redirectUrl, documentId: "destination-1" }),
    worker.nav({ url: redirectUrl, documentId: "destination-2" })
  ]);
  const approvals = await Promise.all([
    worker.message({ documentId: "destination-1" }),
    worker.message({ documentId: "destination-2" })
  ]);
  assert.equal(approvals.filter((result) => result.approved).length, 1);
});

test("ordinary redirects to /work without a handoff ticket are never authorized", async () => {
  const worker = makeWorker();
  await worker.nav({ transitionType: "link", transitionQualifiers: ["client_redirect"] });
  assert.equal((await worker.message()).approved, false);
});

test("allows generated omnibox navigations", async () => {
  const worker = makeWorker();
  await worker.nav({ transitionType: "generated" });
  assert.equal((await worker.message()).approved, true);
});

test("allows Dia's typed omnibox site-search navigation", async () => {
  // Dia's recorded history transition: typed + from_address_bar.
  const worker = makeWorker();
  await worker.nav({ transitionType: "typed", transitionQualifiers: ["from_address_bar"], q: "hi" });
  const approved = await worker.message();
  assert.equal(approved.approved, true);
  assert.equal(approved.query, "hi");
  assert.equal((await worker.message()).approved, false);
});

test("does not approve typed navigations without an address-bar qualifier", async () => {
  const worker = makeWorker();
  await worker.nav({ transitionType: "typed" });
  assert.equal((await worker.message()).approved, false);
});

test("rejects redirect navigations even if tagged as typed or keyword", async () => {
  for (const transitionType of ["typed", "keyword", "generated"]) {
    for (const qualifier of ["client_redirect", "server_redirect"]) {
      const worker = makeWorker();
      await worker.nav({
        transitionType,
        transitionQualifiers: transitionType === "typed" ? ["from_address_bar", qualifier] : [qualifier]
      });
      assert.equal((await worker.message()).approved, false, `${transitionType}: ${qualifier}`);
    }
  }
});

test("rejects links, redirects, reloads and non-omnibox navigations even with the secret", async () => {
  for (const transitionType of ["link", "reload", "form_submit", "auto_bookmark", "keyword_generated"]) {
    const worker = makeWorker();
    await worker.nav({ transitionType });
    assert.equal((await worker.message()).approved, false, transitionType);
  }
});

test("rejects missing or incorrect secrets, blank queries and duplicate parameters", async () => {
  const cases = [
    { token: "1" },
    { token: "12345678901234567890123456789012" },
    { q: "   " },
    { url: `https://chatgpt.com/?q=hello&autosend=${SECRET}&autosend=${SECRET}` },
    { url: `https://chatgpt.com/?q=hello&q=override&autosend=${SECRET}` },
    { url: `https://chatgpt.com/c/old?q=hello&autosend=${SECRET}` },
    { url: `http://chatgpt.com/?q=hello&autosend=${SECRET}` }
  ];
  for (const config of cases) {
    const worker = makeWorker();
    await worker.nav(config);
    assert.equal((await worker.message()).approved, false, JSON.stringify(config));
  }
});

test("approval cannot be transferred to another document in the same tab", async () => {
  const worker = makeWorker();
  await worker.nav({ documentId: "approved-document" });
  assert.equal((await worker.message({ documentId: "attacker-document" })).approved, false);
  assert.equal((await worker.message({ documentId: "approved-document" })).approved, true);
});

test("approval is never available to subframes, other origins or missing document IDs", async () => {
  const worker = makeWorker();
  await worker.nav();
  assert.equal((await worker.message({ frameId: 1 })).approved, false);
  assert.equal((await worker.message({ senderUrl: "https://example.com/" })).approved, false);
  assert.equal((await worker.message({ senderId: "different-extension" })).approved, false);
  assert.equal((await worker.message({ documentId: null })).approved, false);
  assert.equal((await worker.message()).approved, true);
});

test("parallel requests cannot consume the same approval twice", async () => {
  const worker = makeWorker();
  await worker.nav();
  const results = await Promise.all([worker.message(), worker.message()]);
  assert.equal(results.filter((result) => result.approved).length, 1);
});

test("approvals expire and are removed after 30 seconds", async () => {
  const worker = makeWorker();
  await worker.nav();
  worker.advance(30001);
  assert.equal((await worker.message()).approved, false);
  assert.equal(worker.getSessionKeys().length, 0);
});

test("content script can request authorization before onCommitted finishes", async () => {
  const worker = makeWorker();
  const pending = worker.message();
  await worker.nav();
  assert.equal((await pending).approved, true);
});

test("closing a tab removes only that tab's pending approvals", async () => {
  const worker = makeWorker();
  await worker.nav({ tabId: 1 });
  await worker.nav({ tabId: 2 });
  await worker.closeTab(1);
  assert.equal(worker.getSessionKeys().length, 1);
  assert.equal((await worker.message({ tabId: 1 })).approved, false);
  assert.equal((await worker.message({ tabId: 2 })).approved, true);
});

test("setup secret is never returned to ordinary ChatGPT content scripts", async () => {
  const worker = makeWorker();
  const attempt = await worker.message({ type: "autosend-get-setup" });
  assert.equal(attempt.url, undefined);
});
