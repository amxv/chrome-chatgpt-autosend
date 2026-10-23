"use strict";

const input = document.querySelector("#search-url");
const copyButton = document.querySelector("#copy");
const status = document.querySelector("#status");

chrome.runtime.sendMessage({ type: "autosend-get-setup" })
  .then((reply) => {
    if (typeof reply?.url !== "string") throw new Error(reply?.error || "No setup URL received");
    input.value = reply.url;
    copyButton.disabled = false;
    status.textContent = "Copy this URL into your browser's custom site search settings.";
  })
  .catch(() => {
    input.value = "";
    status.textContent = "Setup could not be loaded. Reload this page to try again.";
  });

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = "Copied! Paste this URL into your site-search shortcut.";
  } catch (_) {
    input.focus();
    input.select();
    status.textContent = "Select and copy the highlighted URL, then paste it into your shortcut.";
  }
});
