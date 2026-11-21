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
- Save selected text as a persistent page highlight, choose a color, remove it, or click it to open its associated note. Highlights use the quote and nearby text as a restoration anchor.
- Switch between current-page notes, all notes, and archived notes. Pin or favorite notes, archive and restore them, and group notes into collections.
- Filter the all-notes view by collection; legacy notes receive default organization fields when loaded.
- Clip the main article or page text into a source-linked note.
- Use Markdown checklists and the Tasks view to find notes with unfinished tasks.
- Link notes with `[[Note title]]`; preview links open the matching note and backlinks appear in the editor.
- Restore deleted notes from Trash, review recent note versions, and import or export a complete JSON backup.
- Use the browser context menu or `Alt+Shift+S` to capture selected text, and `Alt+Shift+N` to start a note.
- Copy fenced code blocks from Markdown preview.

Keyboard shortcuts: `Ctrl/Cmd + Shift + D` toggles the panel, `Ctrl/Cmd + K` focuses search, `Alt+Shift+S` captures selected text, `Alt+Shift+N` creates a note, and `Esc` closes the panel. Chrome lets you change extension shortcuts at `chrome://extensions/shortcuts`.

Notes support Markdown syntax. Use **Preview** in the editor to read the formatted note, then choose **Edit** to continue writing.
