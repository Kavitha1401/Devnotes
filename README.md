# DevNotes

DevNotes is a local-first Chrome extension for keeping notes beside the pages they belong to. The content script mounts a React panel inside a closed Shadow DOM so the site cannot style or manipulate its interface.

## Build and install

```sh
npm install
npm run build
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory.

Notes are stored in `chrome.storage.local`, keyed by a normalized page URL. URL fragments and common tracking parameters are removed from the key. In a regular browser preview, DevNotes uses local storage as a development fallback.

## MVP

- Open and close the right-side notes panel from the floating DevNotes button.
- Create, edit, and delete notes; changes save automatically after a short pause, with a visible save status.
- Keep separate notes per page and search across every saved note, including tags and page URLs.
- Add comma-separated tags and export all notes as Markdown.
- Select text on a page and use the ✳ button to start a note with a quotation.

Keyboard shortcuts: `Ctrl/Cmd + Shift + D` toggles the panel, `Ctrl/Cmd + K` focuses search, and `Esc` closes the panel.

The interface is intentionally a lightweight text editor; Markdown syntax can be typed as plain text.
