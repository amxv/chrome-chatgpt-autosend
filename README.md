# ChatGPT Auto-Send for Dia

This tiny Chromium/Dia extension turns a Dia custom site-search shortcut into:

`c` → Space → type prompt → Enter → **ChatGPT opens a new chat and submits it automatically**

## Install in Dia

1. Extract this ZIP somewhere you will keep it.
2. Open `dia://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `dia-chatgpt-autosend` folder.

## Configure your Dia site search

Open:

`dia://settings/searchEngines`

Edit your ChatGPT site search to:

- **Name:** `chatgpt`
- **Shortcut:** `c`
- **URL with %s in place of query:**

```text
https://chatgpt.com/?q=%s&autosend=1
```

Then use:

```text
c what is the fastest way to learn Rust?
```

Dia recognizes `c` + Space as the site-search shortcut. When you press Enter, ChatGPT opens, the extension sees `autosend=1`, and submits the `q` prompt once the composer is ready.

## Notes

- The extension only auto-sends when `autosend=1` is present.
- It only runs on `https://chatgpt.com/*`.
- It stores a per-navigation marker in `sessionStorage` to avoid duplicate sends.
- ChatGPT's web UI can change. The script includes several send-button selectors plus an Enter-key fallback.
