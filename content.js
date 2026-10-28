(() => {
  "use strict";

  // Capture q as early as possible: ChatGPT now removes it from the URL while
  // transferring its contents into the composer.
  const url = new URL(window.location.href);

  // The background worker owns the secret and checks the browser's navigation
  // metadata. The content script never reads the secret or trusts the URL alone.
  if (!/^[0-9a-f]{32}$/.test(url.searchParams.get("autosend") || "")) return;
  const queryAtStart = url.searchParams.get("q")?.trim() || "";

  // A second injection into the same document must not submit again. Unlike
  // sessionStorage, a document-local guard still permits the next site search
  // (including an identical query) in the same tab.
  const startedKey = "__chromeChatgptAutosendStarted";
  if (window[startedKey]) return;
  window[startedKey] = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ChatGPT sometimes offers a Chat / Work switcher at the top of the page.
  // Do not depend on that UI existing: the normal Chat composer still works
  // without it. When it does exist, however, never submit in Work mode.
  const MODE_CONTROLS = 'button, [role="tab"], [role="radio"], [role="button"], a[href]';
  const MODE_GRACE_MS = 800;
  const MODE_SETTLE_MS = 500;
  let sawModeToggle = false;
  let lastChatClick = -Infinity;

  function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" &&
      el.getAttribute("aria-hidden") !== "true" &&
      (typeof el.getClientRects !== "function" || el.getClientRects().length > 0);
  }

  function isTopControl(el) {
    if (typeof el.getBoundingClientRect !== "function") return true;
    const bounds = el.getBoundingClientRect();
    return bounds.top >= 0 && bounds.top < 300;
  }

  function modeLabel(el) {
    return (el.textContent || el.getAttribute("aria-label") || "").trim();
  }

  function getModeToggle() {
    for (const chat of document.querySelectorAll(MODE_CONTROLS)) {
      if (modeLabel(chat) !== "Chat" || !isVisible(chat) || !isTopControl(chat)) continue;
      let parent = chat.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        const controls = [...parent.querySelectorAll(MODE_CONTROLS)].filter(isVisible);
        if (controls.length > 3) break;
        const work = controls.find((el) => modeLabel(el) === "Work" && isTopControl(el));
        if (work && controls.filter((el) => modeLabel(el) === "Chat").length === 1) {
          return { chat, work };
        }
      }
    }
    return null;
  }

  function activeMode(el) {
    for (const attr of ["aria-selected", "aria-pressed", "aria-checked", "data-active", "data-selected"]) {
      const state = el.getAttribute(attr);
      if (state === "true") return true;
      if (state === "false") return false;
    }
    const state = el.getAttribute("data-state");
    if (["active", "on", "checked"].includes(state)) return true;
    if (["inactive", "off", "unchecked"].includes(state)) return false;
    if (el.getAttribute("aria-current") === "page" ||
        el.classList?.contains("active") || el.classList?.contains("selected")) return true;
    return null;
  }

  function chatModeReady() {
    const toggle = getModeToggle();
    if (!toggle) return !sawModeToggle;
    sawModeToggle = true;

    const chatActive = activeMode(toggle.chat) === true;
    const workActive = activeMode(toggle.work) === true;
    if (chatActive && !workActive && Date.now() - lastChatClick >= MODE_SETTLE_MS) {
      return true;
    }

    // If Work is selected (or the selection is indeterminate), try Chat.
    // Fail closed if ChatGPT never confirms the change.
    if (!chatActive && !toggle.chat.disabled && Date.now() - lastChatClick >= 1500) {
      lastChatClick = Date.now();
      toggle.chat.click();
    }
    return false;
  }

  function getPromptElement() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('textarea[placeholder*="Message"]') ||
      document.querySelector('textarea[placeholder*="message"]') ||
      document.querySelector('main [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][data-virtualkeyboard="true"]')
    );
  }

  function promptText(el) {
    if (!el) return "";
    if ("value" in el) return (el.value || "").trim();
    return (el.innerText || el.textContent || "").trim();
  }

  function setPromptText(el, text) {
    if (!el) return false;

    el.focus();

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      descriptor?.set?.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      // execCommand is old but remains useful here because rich-text editors
      // generally observe it as a real editing operation.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (_) {}

      if (!inserted) {
        el.textContent = text;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text
          })
        );
      }
      return true;
    }

    return false;
  }

  function getSendButton(prompt) {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'form button[type="submit"]'
    ];

    // Prefer controls attached to this composer over unrelated page buttons.
    for (const root of [prompt.closest("form"), document]) {
      if (!root) continue;
      for (const selector of selectors) {
        const button = [...root.querySelectorAll(selector)].find((el) => {
          const style = getComputedStyle(el);
          return (
            !el.disabled &&
            el.getAttribute("aria-disabled") !== "true" &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        });
        if (button) return button;
      }
    }

    return null;
  }

  async function run(query) {
    const startedAt = Date.now();
    const deadline = startedAt + 20000;
    let triedEnter = false;

    while (Date.now() < deadline) {
      const readyForChat = chatModeReady();
      // Give the optional mode switcher time to render before submitting a
      // composer that might otherwise be ready immediately.
      if (!readyForChat || Date.now() - startedAt < MODE_GRACE_MS) {
        await sleep(200);
        continue;
      }
      const prompt = getPromptElement();

      if (prompt) {
        let current = promptText(prompt);

        // Let ChatGPT prefill the composer. Only insert text ourselves if we
        // captured q; ChatGPT may strip q from the address bar afterwards.
        if (!current && query && Date.now() - startedAt >= 2000) {
          setPromptText(prompt, query);
          await sleep(200);
          current = promptText(prompt);
        }

        // Never send an unrelated draft if the composer changes unexpectedly.
        if (current && current === query) {
          const sendButton = getSendButton(prompt);

          if (sendButton && chatModeReady()) {
            sendButton.click();
            return;
          }

          // Give the UI time to enable the send button before trying Enter.
          // Only dispatch it once, since retries could duplicate a submission.
          if (!triedEnter && Date.now() - startedAt >= 4000 && chatModeReady()) {
            triedEnter = true;
            prompt.focus();
            const eventInit = {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
              ctrlKey: false,
              metaKey: false,
              shiftKey: false,
              altKey: false
            };
            prompt.dispatchEvent(new KeyboardEvent("keydown", eventInit));
            prompt.dispatchEvent(new KeyboardEvent("keyup", eventInit));
            await sleep(500);
            if (!promptText(prompt)) return;
          }
        }
      }

      await sleep(200);
    }

    console.warn(sawModeToggle
      ? "[ChatGPT Auto-Send for Chrome] Chat mode could not be verified; prompt was NOT sent."
      : "[ChatGPT Auto-Send for Chrome] Timed out waiting for a matching prompt and enabled send button."
    );
  }

  // The worker returns the query from the approved navigation, not from the
  // current address bar (which ChatGPT can modify via history.replaceState).
  async function approved() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "autosend-approval" });
      if (reply?.approved !== true || typeof reply.query !== "string" || !reply.query.trim()) {
        return null;
      }
      if (queryAtStart && queryAtStart !== reply.query) return null;
      return reply.query;
    } catch (_) {
      return null;
    }
  }

  approved().then((query) => {
    if (query) {
      run(query);
    } else {
      console.warn("[ChatGPT Auto-Send for Chrome] Navigation was not an omnibox search; not sending.");
    }
  });
})();
