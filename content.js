(() => {
  "use strict";

  // Capture q as early as possible: ChatGPT now removes it from the URL while
  // transferring its contents into the composer.
  const url = new URL(window.location.href);

  // The background worker owns the secret and checks the browser's navigation
  // metadata. The content script never reads the secret or trusts the URL alone.
  if (!/^[0-9a-f]{32}$/.test(url.searchParams.get("autosend") || "")) return;
  if (url.pathname !== "/work" && url.pathname !== "/") return;
  const queryAtStart = url.searchParams.get("q")?.trim() || "";

  // A second injection into the same document must not submit again. Unlike
  // sessionStorage, a document-local guard still permits the next site search
  // (including an identical query) in the same tab.
  const startedKey = "__chromeChatgptAutosendStarted";
  if (window[startedKey]) return;
  window[startedKey] = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The /work entry point exposes the Chat / Work switcher. Never treat a
  // matching composer or Send button as evidence that we're in Chat mode.
  const MODE_CONTROL = 'button, [role="tab"], [role="radio"], [role="button"], a[href]';

  function modeLabel(el) {
    return (el.textContent || el.getAttribute("aria-label") || "").trim();
  }

  function visible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" &&
      el.getAttribute("aria-hidden") !== "true" &&
      (typeof el.getClientRects !== "function" || el.getClientRects().length > 0);
  }

  function getModeToggle() {
    for (const chat of document.querySelectorAll(MODE_CONTROL)) {
      if (modeLabel(chat) !== "Chat" || !visible(chat)) continue;
      let parent = chat.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        const controls = [...parent.querySelectorAll(MODE_CONTROL)].filter(visible);
        if (controls.length > 3) break; // Don't select unrelated sidebar controls.
        const work = controls.find((el) => modeLabel(el) === "Work");
        if (work && controls.filter((el) => modeLabel(el) === "Chat").length === 1) {
          return { chat, work };
        }
      }
    }
    return null;
  }

  function activeState(el) {
    for (const attribute of ["aria-selected", "aria-pressed", "aria-checked", "data-selected", "data-active"]) {
      const value = el.getAttribute(attribute);
      if (value === "true") return true;
      if (value === "false") return false;
    }
    const state = el.getAttribute("data-state");
    if (["active", "on", "checked"].includes(state)) return true;
    if (["inactive", "off", "unchecked"].includes(state)) return false;
    if (el.getAttribute("aria-current") === "page") return true;
    if (el.classList?.contains("active") || el.classList?.contains("selected")) return true;
    return null;
  }

  let clickedChat = false;
  let lastChatClick = -Infinity;

  function inChatMode() {
    // Don't send into an existing conversation if a separate navigation won
    // the race with the mode switch.
    if (window.location.pathname !== "/work" && window.location.pathname !== "/") return false;
    const toggle = getModeToggle();
    if (toggle && activeState(toggle.chat) === true && activeState(toggle.work) !== true) {
      return true;
    }
    // Some versions of the app remove the switcher after a client-side route
    // change to the Chat page. Accept that only AFTER clicking Chat ourselves.
    return clickedChat && Date.now() - lastChatClick >= 500 &&
      window.location.pathname === "/" &&
      (!toggle || activeState(toggle.work) === false);
  }

  async function selectChat(deadline) {
    let lastClick = -Infinity;
    while (Date.now() < deadline) {
      if (inChatMode()) return true;
      const toggle = getModeToggle();
      if (toggle && !toggle.chat.disabled && Date.now() - lastClick >= 1500) {
        toggle.chat.click();
        clickedChat = true;
        lastClick = Date.now();
        lastChatClick = lastClick;
      }
      await sleep(200);
    }
    console.warn("[ChatGPT Auto-Send for Chrome] Could not verify Chat mode; prompt was NOT sent.");
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

    // Switching modes can recreate the composer and discard a prefilled q.
    // Do not populate or submit anything until Chat is confirmed.
    if (!await selectChat(deadline)) return;

    while (Date.now() < deadline) {
      if (!inChatMode()) {
        console.warn("[ChatGPT Auto-Send for Chrome] Chat mode changed; prompt was NOT sent.");
        return;
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

          if (sendButton && inChatMode()) {
            sendButton.click();
            return;
          }

          // Give the UI time to enable the send button before trying Enter.
          // Only dispatch it once, since retries could duplicate a submission.
          if (!triedEnter && Date.now() - startedAt >= 4000 && inChatMode()) {
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

    console.warn(
      "[ChatGPT Auto-Send for Chrome] Timed out waiting for a matching prompt and enabled send button."
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
      return { query: reply.query, redirectUrl: reply.redirectUrl };
    } catch (_) {
      return null;
    }
  }

  approved().then((approval) => {
    if (approval?.redirectUrl) {
      // Legacy Chrome site-search shortcuts still point to /. Carry the
      // worker-approved navigation to /work with its one-time handoff ticket.
      window.location.replace(approval.redirectUrl);
    } else if (approval && url.pathname === "/work") {
      run(approval.query);
    } else {
      console.warn("[ChatGPT Auto-Send for Chrome] Navigation was not an omnibox search; not sending.");
    }
  });
})();
