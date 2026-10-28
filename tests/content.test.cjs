const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const SECRET = "abcdef0123456789abcdef0123456789";
const source = readFileSync(join(__dirname, "..", "content.js"), "utf8");

function makePage({
  url = `https://chatgpt.com/?autosend=${SECRET}`,
  prefill = "",
  prefillAt = 0,
  composerAt = 0,
  sendEnabledAt = 0,
  sendSelector = 'button[data-testid="send-button"]',
  approved = true,
  approvedQuery,
  modeToggleAt = Infinity,
  initialMode = "work",
  switchDelay = 0,
  switchable = true,
  modeStateSource = "aria",
  modeTop = 40,
  hideModeAfterClick = false,
  workReturnsAt = Infinity
} = {}) {
  let time = 0;
  let entered = "";
  const sends = [];
  const warnings = [];
  const chatClicks = [];
  let selectedChatAt = initialMode === "chat" ? 0 : Infinity;
  let workReturned = false;

  function chatSelected() {
    if (!workReturned && time >= workReturnsAt) {
      workReturned = true;
      selectedChatAt = Infinity;
    }
    return time >= selectedChatAt;
  }

  const toggleParent = {
    parentElement: null,
    querySelectorAll() { return [chatControl, workControl]; }
  };
  const makeModeControl = (label) => ({
    textContent: label,
    parentElement: toggleParent,
    disabled: false,
    getBoundingClientRect() { return { top: modeTop }; },
    getAttribute(attribute) {
      if (attribute === "aria-selected" && modeStateSource === "aria") {
        return String(label === "Chat" ? chatSelected() : !chatSelected());
      }
      if (attribute === "data-state" && modeStateSource === "data-state") {
        return (label === "Chat" ? chatSelected() : !chatSelected()) ? "active" : "inactive";
      }
      return null;
    },
    classList: {
      contains(token) {
        return modeStateSource === "class" && token === "selected" &&
          (label === "Chat" ? chatSelected() : !chatSelected());
      }
    },
    click() {
      if (label === "Chat") {
        chatClicks.push(time);
        if (switchable) selectedChatAt = time + switchDelay;
      }
    }
  });
  const chatControl = makeModeControl("Chat");
  const workControl = makeModeControl("Work");

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
      if (selector.startsWith('button, [role="tab"]')) {
        return time >= modeToggleAt && !(hideModeAfterClick && chatClicks.length > 0)
          ? [chatControl, workControl] : [];
      }
      return selector === sendSelector ? [sendButton] : [];
    }
  };

  const window = { location: { href: url } };
  const query = approvedQuery === undefined
    ? (new URL(url).searchParams.get("q")?.trim() || prefill)
    : approvedQuery;
  const context = vm.createContext({
    window,
    document,
    URL,
    chrome: {
      runtime: { sendMessage: async () => ({ approved, query }) }
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
    url: `https://chatgpt.com/?q=hello%20world&autosend=${SECRET}`,
    prefill: "hello world",
    prefillAt: 1200,
    composerAt: 600,
    sendEnabledAt: 1600
  });
  page.execute();
  page.window.location.href = `https://chatgpt.com/?autosend=${SECRET}`;
  await page.settle();
  assert.deepEqual(page.sends.map((send) => send.text), ["hello world"]);
  assert.ok(page.sends[0].at >= 1600);
});

test("fills from q if ChatGPT never prepopulates the composer", async () => {
  const page = makePage({
    url: `https://chatgpt.com/?q=fallback&autosend=${SECRET}`
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
    url: `https://chatgpt.com/?q=expected&autosend=${SECRET}`,
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
    url: `https://chatgpt.com/?q=original&autosend=${SECRET}`,
    approvedQuery: "tampered",
    prefill: "tampered"
  });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("without a mode toggle, sends directly from the original / page", async () => {
  const page = makePage({ url: `https://chatgpt.com/?q=normal&autosend=${SECRET}`, prefill: "normal" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 1);
  assert.ok(page.sends[0].at >= 800);
  assert.equal(page.chatClicks.length, 0);
});

test("when the top toggle already shows Chat, sends without clicking it", async () => {
  const page = makePage({ prefill: "hi", modeToggleAt: 0, initialMode: "chat" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 1);
  assert.equal(page.chatClicks.length, 0);
});

test("when Work is selected, switches to Chat before submitting", async () => {
  const page = makePage({ prefill: "chat please", modeToggleAt: 0, switchDelay: 1300 });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 1);
  assert.equal(page.sends.length, 1);
  assert.ok(page.sends[0].at >= 1300);
});

test("waits for a delayed top toggle before sending", async () => {
  const page = makePage({ prefill: "delayed mode", modeToggleAt: 600, initialMode: "work" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 1);
  assert.equal(page.chatClicks.length, 1);
  assert.ok(page.chatClicks[0] >= 600);
  assert.ok(page.sends[0].at >= page.chatClicks[0] + 500);
});

test("supports top toggle active-state classes rather than ARIA", async () => {
  const page = makePage({ prefill: "class state", modeToggleAt: 0, modeStateSource: "class" });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 1);
  assert.equal(page.sends.length, 1);
});

test("recognizes an active Chat state on data-state attributes", async () => {
  const page = makePage({ prefill: "data-state", modeToggleAt: 0, modeStateSource: "data-state" });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 1);
  assert.equal(page.sends.length, 1);
});

test("rechecks the mode immediately before submitting a delayed composer", async () => {
  const page = makePage({
    prefill: "still safe", modeToggleAt: 0, initialMode: "chat",
    sendEnabledAt: 1800, workReturnsAt: 1200, switchDelay: 500
  });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 1);
  assert.equal(page.sends.length, 1);
  assert.ok(page.sends[0].at >= page.chatClicks[0] + 500);
});

test("will not submit in Work if the mode switch never succeeds", async () => {
  const page = makePage({ prefill: "don't send", modeToggleAt: 0, switchable: false });
  page.execute();
  await page.settle();
  assert.ok(page.chatClicks.length > 0);
  assert.equal(page.sends.length, 0);
  assert.match(page.warnings.join(" "), /Chat mode could not be verified/);
});

test("will not send if the toggle disappears before confirming Chat", async () => {
  const page = makePage({ prefill: "don't send", modeToggleAt: 0, hideModeAfterClick: true });
  page.execute();
  await page.settle();
  assert.ok(page.chatClicks.length > 0);
  assert.equal(page.sends.length, 0);
});

test("ignores unrelated Chat / Work controls outside the page header", async () => {
  const page = makePage({ prefill: "just send", modeToggleAt: 0, modeTop: 600 });
  page.execute();
  await page.settle();
  assert.equal(page.chatClicks.length, 0);
  assert.equal(page.sends.length, 1);
});
