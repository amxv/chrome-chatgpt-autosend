# ChatGPT Auto-Send for Chrome

This tiny Chrome extension turns a Chrome custom site-search shortcut into:

`c` → Space / Tab → type prompt → Enter → **ChatGPT opens a new chat and submits it automatically**

## Install in Chrome

1. Clone or download this repository somewhere you will keep it.
2. Create your secret: `cp secret.example.js secret.js`, then replace
   `replace-me` with the output of `openssl rand -hex 16`. The extension
   will not load without `secret.js`. It is gitignored; never commit it.
3. Open `chrome://extensions` or `dia://extensions` or similar.
4. Turn on **Developer mode** (top right toggle).
5. Click **Load unpacked**.
6. Select the `chrome-chatgpt-autosend` folder.

After updating an existing installation, click **Reload** for the extension on
`chrome://extensions` (or the equivalent page in your browser).

## Configure your Chrome site search

Open:

`chrome://settings/searchEngines`

Under **Site search**, click **Add** (or edit an existing entry) with:

- **Name:** `ChatGPT`
- **Shortcut:** `c`
- **URL with %s in place of query:**

```text
https://chatgpt.com/?q=%s&autosend=<your secret>
```

Then use:

```text
c what is the fastest way to learn Rust?
```

Chrome recognizes `c` + Space (or Tab) as the site-search shortcut. When you press Enter, ChatGPT opens, the extension sees the matching `autosend` secret, and submits your prompt once the composer is ready. This also works when ChatGPT removes the `q` URL parameter after filling its composer.

## Notes

- The extension only auto-sends when `autosend` matches your secret **and**
  Chrome reports the navigation as an omnibox keyword search
  (`webNavigation` transition type `keyword` or `generated`). Links, redirects
  and `window.open` from other sites never auto-send, even with the secret.
  Without this, any web page could submit prompts as you, including prompts
  that use your ChatGPT connectors or memory.
- Approval is one-shot per navigation, so reloading the page does not resend.
- It only runs on `https://chatgpt.com/*`.
- It submits at most once per page load, even if injected more than once. Each
  new site search can still submit the same prompt again.
- It captures `q` at document start if available. If ChatGPT has already removed
  `q`, it waits for ChatGPT to prefill the composer instead.
- ChatGPT's web UI can change. The script includes several send-button selectors plus an Enter-key fallback.

## Tests

Run `node --test tests/content.test.cjs` to exercise URL cleanup, delayed
composer rendering, and one-shot submission behavior without a ChatGPT login.
