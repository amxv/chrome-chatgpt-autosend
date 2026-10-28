# ChatGPT Auto-Send for Chrome

This tiny Chrome extension turns a Chrome custom site-search shortcut into:

`c` → Space / Tab → type prompt → Enter → **ChatGPT opens, switches to Chat (not Work), and submits automatically**

## Install in Chrome or Dia

1. Clone or download this repository somewhere you will keep it.
2. Open `chrome://extensions` or `dia://extensions` or similar.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the `dia-chatgpt-autosend` folder.
5. The extension opens a **Setup** page with your unique site-search URL. Copy it.

The extension generates and saves a cryptographically random 128-bit secret
automatically. You never need to edit a file or approve individual searches.
You can reopen Setup at any time from the extension's **Details → Extension
options** page.

After updating an existing installation, click **Reload** for the extension on
`chrome://extensions` (or the equivalent page in your browser). Existing `/?q=...`
shortcuts are automatically carried to `/work` with a one-time, secure handoff,
so you can keep your current `c` shortcut. New setups use `/work` directly.
**If upgrading from version 1.1.0, you must still replace your old site-search URL:**
`autosend=1` is no longer accepted. Setup will open automatically on the first
upgrade; you only need to change the shortcut once.

## Configure your Chrome site search

Open:

`chrome://settings/searchEngines`

Under **Site search**, click **Add** (or edit an existing entry) with:

- **Name:** `ChatGPT`
- **Shortcut:** `c`
- **URL with %s in place of query:** paste the URL copied from Setup.

It will look like `https://chatgpt.com/work?q=%s&autosend=<your-random-secret>`.

Then use:

```text
c what is the fastest way to learn Rust?
```

Chrome recognizes `c` + Space (or Tab) as the site-search shortcut. When you press Enter, ChatGPT opens `/work` (where the Chat / Work selector is available), selects **Chat**, verifies Chat is active, then submits the prompt once the Chat composer is ready. If the selector is missing or the mode switch cannot be verified, it does **not** send. This also works when ChatGPT removes the `q` URL parameter after filling its composer.

## Notes

- The extension only auto-sends when `autosend` matches your secret **and**
  the browser reports an address-bar navigation (`webNavigation` transition
  type `typed` in Dia, `keyword` or `generated` in other Chromium browsers).
  Links, redirects and `window.open`
  from other sites do not auto-send, even with the secret.
  Without this, any web page could submit prompts as you, including prompts
  that use your ChatGPT connectors or memory.
- The authorization is bound to the exact browser document and can be consumed
  only once. Reloads or new navigations do not inherit it.
- The secret is stored in this browser profile's extension storage; it is not
  in the repository or available to webpage scripts. Since it appears in the
  site-search URL, avoid sharing that URL in public logs or screenshots.
- It only runs on `https://chatgpt.com/*`.
- It never submits from the default `/` entry page or an unverified Work composer.
  Existing `/` shortcut URLs redirect to `/work` after browser-navigation approval.
- It submits at most once per page load, even if injected more than once. Each
  new site search can still submit the same prompt again.
- It retains the original search query from the approved browser navigation,
  even when ChatGPT later strips `q` from the address bar.
- ChatGPT's web UI can change. The script includes several send-button selectors plus an Enter-key fallback.

## Tests

Run `node --test tests/*.test.cjs` to test authorization, malicious navigations,
legacy shortcut handoffs, Chat / Work mode switching, delayed composer rendering,
and one-shot submission without a ChatGPT login.
