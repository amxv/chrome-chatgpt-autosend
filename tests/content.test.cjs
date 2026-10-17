const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const SECRET = "test-secret-0123456789";
const source = readFileSync(join(__dirname, "..", "content.js"), "utf8");

function makePage({
  url = `https://chatgpt.com/?autosend=${SECRET}`,
  prefill = "",
  prefillAt = 0,
  composerAt = 0,
  sendEnabledAt = 0,
  sendSelector = 'button[data-testid="send-button"]',
  secret = SECRET,
  approved = true
} = {}) {
  let time = 0;
  let entered = "";
  const sends = [];
  const warnings = [];

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
      return selector === sendSelector ? [sendButton] : [];
    }
  };

  const window = { location: { href: url } };
  const context = vm.createContext({
    window,
    document,
    URL,
    AUTOSEND_SECRET: secret,
    chrome: {
      runtime: { sendMessage: async () => ({ approved }) }
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

test("never sends when autosend does not match the secret", async () => {
  const page = makePage({ url: "https://chatgpt.com/?q=hi&autosend=1", prefill: "hi" });
  page.execute();
  await page.settle();
  assert.equal(page.sends.length, 0);
});

test("never sends when the secret is unset or too short", async () => {
  const page = makePage({
    url: "https://chatgpt.com/?q=hi&autosend=short",
    prefill: "hi",
    secret: "short"
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
