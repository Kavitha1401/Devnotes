# DevNotes

DevNotes is a local-first Chrome extension for keeping notes beside the pages they belong to. The content script mounts a React panel inside a closed Shadow DOM to isolate its internal UI and styles from the host page. The host page can still remove the outer panel element, and saved highlights are rendered as marks in the page DOM.

## Build and install

```sh
npm install
npm run build
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory.

Notes are stored in `chrome.storage.local`, keyed by a normalized page URL. Fragments, common tracking parameters, and common authentication parameters are removed from the key. In a regular browser preview, DevNotes uses local storage as a development fallback.

## Architecture and privacy

The extension runs a React content script inside a closed Shadow DOM. Note records, collections, highlights, and Trash stay in local extension storage; there is no account or remote sync. Captured page text and clips are stored as plain text, so avoid saving secrets. URL fragments and parameters commonly used for authentication or tracking are removed from stored page keys and exported source links. When restoring highlights, DevNotes scans page text nodes for saved quotes.

The `storage` permission saves local notes. `unlimitedStorage` supports larger local libraries and backups. `contextMenus` adds the selection capture command. `scripting` lets the service worker recover on tabs that were already open when DevNotes was reloaded. The extension matches all HTTP and HTTPS pages so page-specific notes and restored highlights work across sites; it scans text nodes to restore saved quotes and reads article text when you clip a page.

Markdown preview sanitizes generated HTML, removes images to prevent remote tracking requests, and opens external links in a separate tab. It is still a local, unencrypted store.

## Features

- Open and close the right-side notes panel from the floating DevNotes button.
- Create, edit, and delete notes; changes save automatically after a short pause, with a visible save status.
- Keep separate notes per page and search across every saved note, including tags and page URLs.
- Add comma-separated tags and export all notes as Markdown.
- Select text on a page and use the ✳ button to start a note with a quotation.
- Save selected text as a persistent page highlight, choose a color, remove it, or click it to open its associated note. Highlights use the quote and nearby text as a restoration anchor.
- Switch between current-page notes, all notes, and archived notes. Pin or favorite notes, archive and restore them, and group notes into collections.
- Filter the all-notes view by collection; legacy notes receive default organization fields when loaded.
- Clip the main article or page text into a source-linked note.
- Use Markdown checklists and the Tasks view to find notes with unfinished tasks.
- Link notes with the editor’s **Link a note…** selector. These use stable note IDs, and backlinks appear in the editor. Legacy `[[Note title]]` links also work when titles are unique.
- Restore deleted notes from Trash, review recent note versions, and import or export a complete JSON backup.
- Use the browser context menu or `Alt+Shift+S` to capture selected text, and `Alt+Shift+N` to start a note.
- Copy fenced code blocks from Markdown preview.
- Disable DevNotes per site, with default protection for common banking and email hosts. Re-enable a blocked site from the extension toolbar.
- Configure theme, panel side and width, launcher position or visibility, default highlight color, Trash retention, and version-history depth in Settings.

Keyboard shortcuts: `Alt+Shift+D` toggles the panel, `Alt+Shift+K` focuses search, `Alt+Shift+S` captures selected text, `Alt+Shift+N` creates a note, and `Esc` closes the open panel. Search also accepts `Ctrl/Cmd+K` while DevNotes is open. Chrome lets you change extension shortcuts at `chrome://extensions/shortcuts`.

Notes support Markdown syntax. Use **Preview** in the editor to read the formatted note, then choose **Edit** to continue writing.
