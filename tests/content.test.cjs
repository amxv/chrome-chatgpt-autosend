const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const SECRET = "abcdef0123456789abcdef0123456789";
const source = readFileSync(join(__dirname, "..", "content.js"), "utf8");

function makePage({
  url = `https://chatgpt.com/work?autosend=${SECRET}`,
  prefill = "",
  prefillAt = 0,
  composerAt = 0,
  sendEnabledAt = 0,
  sendSelector = 'button[data-testid="send-button"]',
  approved = true,
  approvedQuery,
  redirectUrl,
  toggleAt = 0,
  toggleMissing = false,
  initialMode = "work",
  switchDelay = 0,
  switchEffect = "aria",
  workReturnsAt = Infinity
} = {}) {
  let time = 0;
  let entered = "";
  let chatSelectedAt = initialMode === "chat" ? 0 : Infinity;
  const sends = [];
  const warnings = [];
  const chatClicks = [];
  const redirects = [];

  const window = {
    location: {
      href: url,
      pathname: new URL(url).pathname,
      replace(next) { redirects.push(next); }
    }
  };

  function chatSelected() {
    const selected = time >= chatSelectedAt && time < workReturnsAt;
    if (selected && switchEffect === "route") window.location.pathname = "/";
    if (selected && switchEffect === "other-route") window.location.pathname = "/c/old-chat";
    return selected;
  }

  const toggleParent = {
    parentElement: null,
    querySelectorAll() { return [chatButton, workButton]; }
  };
  const chatButton = {
    textContent: "Chat",
    parentElement: toggleParent,
    disabled: false,
    getAttribute(attr) {
      if (attr === "aria-selected" && switchEffect === "aria") return String(chatSelected());
      return null;
    },
    click() {
      chatClicks.push(time);
      if (switchEffect !== "never") chatSelectedAt = time + switchDelay;
    }
  };
  const workButton = {
    textContent: "Work",
    parentElement: toggleParent,
    getAttribute(attr) {
      if (attr === "aria-selected" && switchEffect === "aria") return String(!chatSelected());
      return null;
    }
  };

  class TextArea {
    get value() {
      return entered || (time >= prefillAt ? prefill : "");
    }

    set value(next) {
      entered = next;
    }

    focus() {}
    dispatchEvent() {}
    closest() { return null; }
  }

  const prompt = new TextArea();
  const sendButton = {
    get disabled() { return time < sendEnabledAt; },
    getAttribute() { return null; },
    click() { sends.push({ text: prompt.value, at: time }); }
  };

  const document = {
    querySelector(selector) {
      return time >= composerAt && selector === "#prompt-textarea" ? prompt : null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith("button, [role=")) {
        return !toggleMissing && time >= toggleAt &&
          !(["route", "other-route"].includes(switchEffect) && chatSelected()) ? [chatButton, workButton] : [];
      }
      return selector === sendSelector ? [sendButton] : [];
    }
  };

  const query = approvedQuery === undefined
    ? (new URL(url).searchParams.get("q")?.trim() || prefill)
    : approvedQuery;
  const context = vm.createContext({
    window,
    document,
    URL,
    chrome: {
      runtime: { sendMessage: async () => ({ approved, query, redirectUrl }) }
    },
    HTMLTextAreaElement: TextArea,
    HTMLInputElement: class {},
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    console: { warn(message) { warnings.push(message); } },
    Date: class extends Date { static now() { return time; } },
    setTimeout(callback, ms) {
      time += ms;
      setImmediate(callback);
    }
  });

  return {
    window,
    prompt,
    sends,
    warnings,
    chatClicks,
    redirects,
    execute() { vm.runInContext(source, context); },
    // Timers use setImmediate, so even a 20s simulated timeout completes fast.
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
}

test("sends a prefilled composer when ChatGPT has already removed q", async () => {
  const page = makePage({ prefill: "hi", prefillAt: 1000 });
  page.execute();
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["hi"]);
});

test("captures q before ChatGPT removes it and waits for the composer", async () => {
  const page = makePage({
    url: `https://chatgpt.com/work?q=hello%20world&autosend=${SECRET}`,
    prefill: "hello world",
    prefillAt: 1200,
    composerAt: 600,
    sendEnabledAt: 1600
  });
  page.execute();
  page.window.location.href = `https://chatgpt.com/work?autosend=${SECRET}`;
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["hello world"]);
  assert.ok(page.sends[0].at >= 1600);
});

test("fills from q if ChatGPT never prepopulates the composer", async () => {
  const page = makePage({
    url: `https://chatgpt.com/work?q=fallback&autosend=${SECRET}`
  });
  page.execute();
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["fallback"]);
});

test("recognizes the newer Send aria-label", async () => {
  const page = makePage({
    prefill: "new ui",
    sendSelector: 'button[aria-label="Send"]'
  });
  page.execute();
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["new ui"]);
});

test("never sends without the autosend flag", async () => {
  const page = makePage({
    url: "https://chatgpt.com/?q=hi",
    prefill: "hi"
  });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("never submits an empty composer if q is gone", async () => {
  const page = makePage();
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
  assert.equal(page.warnings.length, 1);
});

test("does not submit an unrelated pre-existing draft", async () => {
  const page = makePage({
    url: `https://chatgpt.com/work?q=expected&autosend=${SECRET}`,
    prefill: "different text"
  });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("repeated injection into one document cannot duplicate a send", async () => {
  const page = makePage({ prefill: "hello" });
  page.execute();
  page.execute();
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["hello"]);
});

test("old autosend=1 no longer sends", async () => {
  const page = makePage({ url: "https://chatgpt.com/?q=hi&autosend=1", prefill: "hi" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("malformed autosend values do not trigger an approval request", async () => {
  const page = makePage({
    url: "https://chatgpt.com/?q=hi&autosend=short",
    prefill: "hi"
  });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("never sends when the background worker denies approval", async () => {
  const page = makePage({ prefill: "hi", approved: false });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("never sends without a query in the approved navigation", async () => {
  const page = makePage({ prefill: "old draft", approvedQuery: "" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("never sends if the URL query differs from the approved navigation", async () => {
  const page = makePage({
    url: `https://chatgpt.com/work?q=original&autosend=${SECRET}`,
    approvedQuery: "tampered",
    prefill: "tampered"
  });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("switches from Work to Chat before sending, even if composer was ready", async () => {
  const page = makePage({ prefill: "chat only", switchDelay: 1400 });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 1);
  assert.deepEqual(page.sends.map(({ text }) => text), ["chat only"]);
  assert.ok(page.sends[0].at >= 1400);
});

test("waits for the Chat / Work selector to render before clicking", async () => {
  const page = makePage({ prefill: "delayed toggle", toggleAt: 1700 });
  page.execute();
  await page.settle();
  assert.ok(page.chatClicks[0] >= 1700);
  assert.equal(page.sends.length, 1);
});

test("supports the Chat switch removing the toggle via an SPA route change", async () => {
  const page = makePage({ prefill: "route change", switchEffect: "route", switchDelay: 400 });
  page.execute();
  await page.settle();
  assert.equal(page.window.location.pathname, "/");
  assert.equal(page.sends.length, 1);
});

test("never sends after an unrelated route change during the mode switch", async () => {
  const page = makePage({ prefill: "must not send", switchEffect: "other-route" });
  page.execute();
  await page.settle();
  assert.equal(page.window.location.pathname, "/c/old-chat");
  assert.equal(page.sends.length, 0);
});

test("never sends if the Chat / Work selector never appears", async () => {
  const page = makePage({ prefill: "must not send", toggleMissing: true });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
  assert.match(page.warnings.join(" "), /Could not verify Chat mode/);
});

test("never sends if clicking Chat does not confirm the mode switch", async () => {
  const page = makePage({ prefill: "must not send", switchEffect: "never" });
  page.execute();
  await page.settle();
  assert.ok(page.chatClicks.length > 0);
  assert.equal(page.sends.length, 0);
});

test("never sends if Work becomes active again while waiting for the composer", async () => {
  const page = makePage({ prefill: "must not send", composerAt: 1200, workReturnsAt: 800 });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
  assert.match(page.warnings.join(" "), /Chat mode changed/);
});

test("does not click Chat again when it is already selected", async () => {
  const page = makePage({ prefill: "already chat", initialMode: "chat" });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 0);
  assert.equal(page.sends.length, 1);
});

test("legacy root shortcuts redirect to /work rather than sending on root", async () => {
  const workUrl = `https://chatgpt.com/work?q=legacy&autosend=${SECRET}&autosend_handoff=ticket`;
  const page = makePage({
    url: `https://chatgpt.com/?q=legacy&autosend=${SECRET}`,
    prefill: "legacy",
    redirectUrl: workUrl
  });
  page.execute();
  await page.settle();
  assert.deepEqual(page.redirects, [workUrl]);
  assert.equal(page.sends.length, 0);
});

test("never sends from root without a verified migration handoff", async () => {
  const page = makePage({ url: `https://chatgpt.com/?q=root&autosend=${SECRET}`, prefill: "root" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});
