(() => {
  "use strict";

  // Only act on URLs created specifically for this extension.
  const url = new URL(window.location.href);
  const query = url.searchParams.get("q");
  const autoSend = url.searchParams.get("autosend");

  if (!query || autoSend !== "1") return;

  // Prevent duplicate submission if ChatGPT re-renders or the content script
  // is injected again for the same navigation.
  const submissionKey = `dia-chatgpt-autosend:${window.location.href}`;
  if (sessionStorage.getItem(submissionKey) === "done") return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getPromptElement() {
    return (
      document.querySelector("#prompt-textarea") ||
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

  function getSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'form button[type="submit"]'
    ];

    for (const selector of selectors) {
      const buttons = [...document.querySelectorAll(selector)];
      const button = buttons.find((el) => {
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

    return null;
  }

  async function run() {
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      const prompt = getPromptElement();

      if (prompt) {
        let current = promptText(prompt);

        // ChatGPT normally fills ?q= for us. If it hasn't yet, wait briefly,
        // then fill it ourselves as a fallback.
        if (!current) {
          await sleep(250);
          current = promptText(prompt);
          if (!current) {
            setPromptText(prompt, query);
            await sleep(250);
            current = promptText(prompt);
          }
        }

        if (current) {
          const sendButton = getSendButton();

          if (sendButton) {
            sessionStorage.setItem(submissionKey, "done");
            sendButton.click();
            return;
          }

          // Fallback for UI revisions where the send button selector changed.
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

          // Give the UI a moment to react. If the prompt was cleared, it sent.
          await sleep(500);
          if (!promptText(prompt)) {
            sessionStorage.setItem(submissionKey, "done");
            return;
          }
        }
      }

      await sleep(200);
    }

    console.warn(
      "[ChatGPT Auto-Send for Dia] Timed out waiting for the ChatGPT composer."
    );
  }

  run();
})();
