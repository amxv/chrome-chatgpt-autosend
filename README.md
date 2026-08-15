# ChatGPT Auto-Send for Chrome

This tiny Chrome extension turns a Chrome custom site-search shortcut into:

`c` → Space / Tab → type prompt → Enter → **ChatGPT opens a new chat and submits it automatically**

## Install in Chrome

1. Clone or download this repository somewhere you will keep it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked**.
5. Select the `chrome-chatgpt-autosend` folder.

## Configure your Chrome site search

Open:

`chrome://settings/searchEngines`

Under **Site search**, click **Add** (or edit an existing entry) with:

- **Name:** `ChatGPT`
- **Shortcut:** `c`
- **URL with %s in place of query:**

```text
https://chatgpt.com/?q=%s&autosend=1
```

Then use:

```text
c what is the fastest way to learn Rust?
```

Chrome recognizes `c` + Space (or Tab) as the site-search shortcut. When you press Enter, ChatGPT opens, the extension sees `autosend=1`, and submits the `q` prompt once the composer is ready.

## Notes

- The extension only auto-sends when `autosend=1` is present.
- It only runs on `https://chatgpt.com/*`.
- It stores a per-navigation marker in `sessionStorage` to avoid duplicate sends.
- ChatGPT's web UI can change. The script includes several send-button selectors plus an Enter-key fallback.

