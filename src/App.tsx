import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { DEFAULT_BLOCKED_HOSTS, DEFAULT_SETTINGS, HIGHLIGHT_COLORS, SETTINGS_KEY, hostMatches, isHostDisabled, normalizeHost, normalizeSettings, readSettings, writeSettings, type DevNotesSettings } from './settings'

type Note = { id: string; title: string; body: string; tags?: string[]; collectionIds?: string[]; pinned?: boolean; favorite?: boolean; archived?: boolean; history?: Revision[]; createdAt: number; updatedAt: number }
type Revision = { id: string; title: string; body: string; savedAt: number }
type PageNotes = Record<string, Note[]>
type Collection = { id: string; name: string; createdAt: number }
type Highlight = { id: string; noteId?: string; text: string; prefix: string; suffix: string; color: string; createdAt: number }
type TrashEntry = { note: Note; url: string; deletedAt: number }
type BackupFile = { format: 'devnotes-backup'; version: number; pages: PageNotes; collections: Collection[]; highlights: Record<string, Highlight[]>; trash: TrashEntry[]; settings?: DevNotesSettings }

const STORAGE_KEY = 'devnotes-pages'
const DELETED_KEY = 'devnotes-deleted-notes'
const HIGHLIGHT_KEY = 'devnotes-highlights'
const COLLECTION_KEY = 'devnotes-collections'
const TRASH_KEY = 'devnotes-trash'
const NOTE_TEMPLATES = {
  'Bug report': '# Bug report\n\n## Summary\n\n## Steps to reproduce\n1. \n\n## Expected behavior\n\n## Actual behavior\n\n## Environment\n',
  'Meeting notes': '# Meeting notes\n\nDate: \nAttendees: \n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n- [ ] \n',
  'Reading note': '# Reading note\n\n## Summary\n\n## Key ideas\n- \n\n## Quotes\n> \n\n## My thoughts\n\n## Follow-up\n',
} as const
function normalizePageUrl(href: string) {
  const url = new URL(href)
  url.hash = ''
  // Tracking parameters do not make a page a different note destination.
  const trackingKeys: string[] = []
  url.searchParams.forEach((_value, key) => { if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid|token|access_token|refresh_token|auth|authorization|session|sessionid|sid|api_key|apikey|key|code|password|secret|jwt)$/i.test(key)) trackingKeys.push(key) })
  for (const key of trackingKeys) {
    url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.toString().replace(/\/$/, '')
}

function migratePages(value: PageNotes): PageNotes {
  if (!isRecord(value)) return {}
  const pages: PageNotes = {}
  for (const [url, rawNotes] of Object.entries(value)) {
    let normalizedUrl: string
    try {
      normalizedUrl = normalizePageUrl(url)
      if (!/^https?:$/.test(new URL(normalizedUrl).protocol)) continue
    } catch { continue }
    if (!Array.isArray(rawNotes)) continue
    const notes = rawNotes.filter((note): note is Note => isRecord(note) && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.body === 'string' && typeof note.createdAt === 'number' && typeof note.updatedAt === 'number').map((note) => ({
      ...note,
      tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      collectionIds: Array.isArray(note.collectionIds) ? note.collectionIds.filter((id): id is string => typeof id === 'string') : [],
      history: Array.isArray(note.history) ? note.history.filter((item): item is Revision => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string' && typeof item.savedAt === 'number').slice(-20) : [],
      pinned: Boolean(note.pinned),
      favorite: Boolean(note.favorite),
      archived: Boolean(note.archived),
    }))
    pages[normalizedUrl] = [...(pages[normalizedUrl] ?? []), ...notes]
  }
  return pages
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatePageNotes(value: unknown): PageNotes | null {
  if (!isRecord(value)) return null
  const result: PageNotes = {}
  for (const [url, rawNotes] of Object.entries(value)) {
    try { if (!/^https?:$/.test(new URL(url).protocol)) return null } catch { return null }
    if (!Array.isArray(rawNotes) || rawNotes.some((note) => !isRecord(note) || typeof note.id !== 'string' || typeof note.title !== 'string' || typeof note.body !== 'string' || typeof note.createdAt !== 'number' || typeof note.updatedAt !== 'number')) return null
    result[normalizePageUrl(url)] = rawNotes as Note[]
  }
  return migratePages(result)
}

function validateBackup(value: unknown): BackupFile | null {
  if (!isRecord(value) || value.format !== 'devnotes-backup' || typeof value.version !== 'number') return null
  const pages = validatePageNotes(value.pages)
  if (!pages) return null
  const collections = value.collections === undefined ? [] : value.collections
  if (!Array.isArray(collections) || collections.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string')) return null
  const highlights = value.highlights === undefined ? {} : value.highlights
  if (!isRecord(highlights) || Object.values(highlights).some((items) => !Array.isArray(items) || items.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.prefix !== 'string' || typeof item.suffix !== 'string' || typeof item.color !== 'string'))) return null
  const normalizedHighlights: Record<string, Highlight[]> = {}
  for (const [url, items] of Object.entries(highlights)) {
    try {
      const normalizedUrl = normalizePageUrl(url)
      if (!/^https?:$/.test(new URL(normalizedUrl).protocol)) return null
      normalizedHighlights[normalizedUrl] = (items as Highlight[]).filter((item) => item.text.length > 0 && item.text.length <= 5_000).map((item) => ({ ...item, color: ['#f6e58d', '#c8e6a0', '#b7dff2', '#f2c5d2'].includes(item.color) ? item.color : '#f6e58d' }))
    } catch { return null }
  }
  const trash = value.trash === undefined ? [] : value.trash
  if (!Array.isArray(trash) || trash.some((item) => !isRecord(item) || typeof item.url !== 'string' || typeof item.deletedAt !== 'number' || validatePageNotes({ [item.url]: [item.note] }) === null)) return null
  const normalizedTrash = (trash as TrashEntry[]).map((item) => ({ ...item, url: normalizePageUrl(item.url) }))
  return { format: 'devnotes-backup', version: value.version, pages, collections: collections as Collection[], highlights: normalizedHighlights, trash: normalizedTrash, settings: value.settings === undefined ? undefined : normalizeSettings(value.settings) }
}

function mergePages(current: PageNotes, incoming: PageNotes): PageNotes {
  const merged: PageNotes = { ...current }
  for (const [url, notes] of Object.entries(incoming)) {
    const byId = new Map((merged[url] ?? []).map((note) => [note.id, note]))
    for (const note of notes) {
      const previous = byId.get(note.id)
      if (!previous || note.updatedAt >= previous.updatedAt) byId.set(note.id, note)
    }
    merged[url] = [...byId.values()]
  }
  return merged
}

function removeDeletedPages(pages: PageNotes, deleted: Record<string, number>): PageNotes {
  return Object.fromEntries(Object.entries(pages).map(([url, notes]) => [url, notes.filter((note) => !deleted[note.id])]))
}

function pruneTombstones(value: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000
  return Object.fromEntries(Object.entries(value).filter(([, deletedAt]) => typeof deletedAt === 'number' && deletedAt >= cutoff).sort((a, b) => a[1] - b[1]).slice(-2_000))
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Unknown page' }
}

function readDeletedNotes(): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(DELETED_KEY, (result) => resolve((result[DELETED_KEY] as Record<string, number> | undefined) ?? {}))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve({}); return }
    try { resolve(JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}')) } catch { resolve({}) }
  })
}

function readPages(): Promise<PageNotes> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(STORAGE_KEY, (result) => resolve(migratePages((result[STORAGE_KEY] as PageNotes | undefined) ?? {})))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve({}); return }
    try { resolve(migratePages(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))) } catch { resolve({}) }
  })
}

function writePages(pages: PageNotes, deletedNotes: Record<string, number> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY, DELETED_KEY], (result) => {
        const current = migratePages((result[STORAGE_KEY] as PageNotes | undefined) ?? {})
        let deleted = pruneTombstones({ ...((result[DELETED_KEY] as Record<string, number> | undefined) ?? {}), ...deletedNotes })
        for (const notes of Object.values(pages)) for (const note of notes) if (note.updatedAt > (deleted[note.id] ?? 0)) delete deleted[note.id]
        deleted = pruneTombstones(deleted)
        const merged = removeDeletedPages(mergePages(current, pages), deleted)
        chrome.storage.local.set({ [STORAGE_KEY]: merged, [DELETED_KEY]: deleted }, () => {
          const error = chrome.runtime.lastError
          if (error) reject(new Error(error.message))
          else resolve()
        })
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable. Reload DevNotes and refresh this page.')); return }
    try {
      const current = migratePages(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
      let deleted = pruneTombstones({ ...JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}'), ...deletedNotes })
      for (const notes of Object.values(pages)) for (const note of notes) if (note.updatedAt > (deleted[note.id] ?? 0)) delete deleted[note.id]
      deleted = pruneTombstones(deleted)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(removeDeletedPages(mergePages(current, pages), deleted)))
      localStorage.setItem(DELETED_KEY, JSON.stringify(deleted))
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

function readHighlights(): Promise<Record<string, Highlight[]>> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(HIGHLIGHT_KEY, (result) => resolve(normalizeHighlights(result[HIGHLIGHT_KEY])))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve({}); return }
    try { resolve(normalizeHighlights(JSON.parse(localStorage.getItem(HIGHLIGHT_KEY) ?? '{}'))) } catch { resolve({}) }
  })
}

function writeHighlights(highlights: Record<string, Highlight[]>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [HIGHLIGHT_KEY]: highlights }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable.')); return }
    try { localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(highlights)); resolve() } catch (error) { reject(error) }
  })
}

function normalizeHighlights(value: unknown): Record<string, Highlight[]> {
  if (!isRecord(value)) return {}
  const normalized: Record<string, Highlight[]> = {}
  for (const [url, items] of Object.entries(value)) {
    try {
      const key = normalizePageUrl(url)
      if (/^https?:$/.test(new URL(key).protocol) && Array.isArray(items)) normalized[key] = items.filter((item): item is Highlight => isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.prefix === 'string' && typeof item.suffix === 'string' && typeof item.color === 'string' && item.text.length <= 5_000)
    } catch { /* Skip malformed legacy anchors. */ }
  }
  return normalized
}

function readCollections(): Promise<Collection[]> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(COLLECTION_KEY, (result) => resolve((result[COLLECTION_KEY] as Collection[] | undefined) ?? []))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve([]); return }
    try { resolve(JSON.parse(localStorage.getItem(COLLECTION_KEY) ?? '[]')) } catch { resolve([]) }
  })
}

function writeCollections(collections: Collection[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [COLLECTION_KEY]: collections }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable.')); return }
    try { localStorage.setItem(COLLECTION_KEY, JSON.stringify(collections)); resolve() } catch (error) { reject(error) }
  })
}

function readTrash(): Promise<TrashEntry[]> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(TRASH_KEY, (result) => resolve(boundedTrash((result[TRASH_KEY] as TrashEntry[] | undefined) ?? [], 3650)))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve([]); return }
    try { resolve(boundedTrash(JSON.parse(localStorage.getItem(TRASH_KEY) ?? '[]'), 3650)) } catch { resolve([]) }
  })
}

function writeTrash(trash: TrashEntry[], retentionDays = DEFAULT_SETTINGS.trashRetentionDays): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [TRASH_KEY]: boundedTrash(trash, retentionDays) }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable.')); return }
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(boundedTrash(trash, retentionDays))); resolve() } catch (error) { reject(error) }
  })
}

function boundedTrash(items: TrashEntry[], retentionDays = DEFAULT_SETTINGS.trashRetentionDays): TrashEntry[] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const valid: TrashEntry[] = []
  for (const item of items) {
    if (!item || typeof item.deletedAt !== 'number' || item.deletedAt < cutoff || typeof item.url !== 'string' || typeof item.note?.id !== 'string') continue
    try {
      const url = normalizePageUrl(item.url)
      if (/^https?:$/.test(new URL(url).protocol)) valid.push({ ...item, url })
    } catch { /* Drop malformed entries instead of crashing the notes panel. */ }
  }
  return valid.slice(-100)
}

function pageTextNodes(): Text[] {
  if (!document.body) return []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!node.textContent || parent?.closest('script, style, noscript, textarea, input, select, [contenteditable="true"], #devnotes-root')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function wrapTextOffsets(nodes: Text[], start: number, end: number, id: string, color: string) {
  let offset = 0
  for (const node of nodes) {
    const text = node.textContent ?? ''
    const from = Math.max(0, start - offset)
    const to = Math.min(text.length, end - offset)
    if (to > from) {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      const mark = document.createElement('mark')
      mark.dataset.devnotesHighlight = id
      mark.style.cssText = `background:${color}; color:inherit; border-radius:2px; padding:0 1px;`
      try { range.surroundContents(mark) } catch { /* Leave text visible if a site mutates the selected node mid-restore. */ }
    }
    offset += text.length
    if (offset >= end) break
  }
}

function applyHighlights(highlights: Highlight[]): string[] {
  if (!document.body) return []
  clearPageHighlights()
  const orphaned: string[] = []
  for (const item of highlights) {
    if (!item.text) continue
    const nodes = pageTextNodes()
    const text = nodes.map((node) => node.textContent ?? '').join('')
    let index = text.indexOf(item.text)
    while (index >= 0) {
      const before = text.slice(Math.max(0, index - item.prefix.length), index)
      const after = text.slice(index + item.text.length, index + item.text.length + item.suffix.length)
      if ((!item.prefix || before.endsWith(item.prefix)) && (!item.suffix || after.startsWith(item.suffix))) break
      index = text.indexOf(item.text, index + 1)
    }
    if (index >= 0) wrapTextOffsets(nodes, index, index + item.text.length, item.id, item.color)
    else orphaned.push(item.id)
  }
  return orphaned
}

function clearPageHighlights() {
  document.querySelectorAll<HTMLElement>('[data-devnotes-highlight]').forEach((mark) => mark.replaceWith(...Array.from(mark.childNodes)))
}

function renderNoteMarkdown(source: string): string {
  const linked = source
    .replace(/\[\[id:([^\]|]+)\|([^\]]+)\]\]/g, (_match, id: string, title: string) => `[${title}](#devnotes-note-id-${encodeURIComponent(id)})`)
    .replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => `[${title}](#devnotes-note-${encodeURIComponent(title)})`)
  const parsed = marked.parse(linked, { async: false })
  let taskIndex = 0
  const controls = parsed
    .replace(/<input\b([^>]*type="checkbox"[^>]*)>/g, (_match, attributes: string) => `<input${attributes.replace(/\sdisabled(?:="")?/g, '')} data-task-index="${taskIndex++}">`)
    .replace(/<\/pre>/g, '<button type="button" data-copy-code>Copy</button></pre>')
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(controls, { FORBID_TAGS: ['img'] })
  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (anchor.getAttribute('href')?.startsWith('#devnotes-note-')) return
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer nofollow'
  })
  return template.innerHTML
}

function TagInput({ tags, onCommit }: { tags: string[]; onCommit: (tags: string[]) => void }) {
  const [draft, setDraft] = useState(tags.join(', '))

  const commit = (leaveSeparator = false) => {
    const next = [...new Map(draft.split(',').map((tag) => tag.trim()).filter(Boolean).map((tag) => [tag.toLowerCase(), tag])).values()]
    if (next.length !== tags.length || next.some((tag, index) => tag !== tags[index])) onCommit(next)
    setDraft(next.join(', ') + (leaveSeparator && next.length ? ', ' : ''))
  }

  return <input className="dn-tags" aria-label="Note tags" placeholder="Add tags, separated by commas" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => commit()} onKeyDown={(event) => {
    if (event.key === ',') { event.preventDefault(); commit(true) }
    if (event.key === 'Enter') { event.preventDefault(); commit() }
  }} />
}

type SearchQuery = { terms: string[]; tags: string[]; sites: string[]; flags: string[]; after?: number; before?: number }

function parseSearchQuery(query: string): SearchQuery {
  const parsed: SearchQuery = { terms: [], tags: [], sites: [], flags: [] }
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  for (const token of tokens) {
    const split = token.indexOf(':')
    if (split < 0) { parsed.terms.push(token.replace(/^"|"$/g, '').toLowerCase()); continue }
    const key = token.slice(0, split).toLowerCase()
    const value = token.slice(split + 1).replace(/^"|"$/g, '').toLowerCase()
    if (key === 'tag' && value) parsed.tags.push(value)
    else if ((key === 'site' || key === 'domain') && value) parsed.sites.push(value)
    else if (key === 'is' && value) parsed.flags.push(value)
    else if (key === 'after' && /^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.after = new Date(`${value}T00:00:00`).getTime()
    else if (key === 'before' && /^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.before = new Date(`${value}T23:59:59`).getTime()
    else parsed.terms.push(token.toLowerCase())
  }
  return parsed
}

function fuzzyContains(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true
  if (term.length < 5) return false
  const words = haystack.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return words.some((word) => {
    if (Math.abs(word.length - term.length) > 1) return false
    let previous = Array.from({ length: term.length + 1 }, (_item, index) => index)
    for (let row = 1; row <= word.length; row++) {
      const current = [row]
      for (let column = 1; column <= term.length; column++) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (word[row - 1] === term[column - 1] ? 0 : 1))
      previous = current
    }
    return previous[term.length] <= 1
  })
}

function SearchMatch({ text, query }: { text: string; query: string }) {
  const terms = parseSearchQuery(query).terms.filter((term) => term.length > 1)
  if (!terms.length) return <>{text}</>
  const escaped = terms.sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'ig'))
  return <>{parts.map((part, index) => terms.some((term) => term.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part)}</>
}

function LinkNoteInput({ notes, onLink }: { notes: { note: Note; url: string }[]; onLink: (id: string, title: string) => void }) {
  const [selectedId, setSelectedId] = useState('')
  return <select className="dn-link-note" aria-label="Link another note" value={selectedId} onChange={(event) => {
    const match = notes.find(({ note }) => note.id === event.target.value)
    if (match) onLink(match.note.id, match.note.title || 'Untitled note')
    setSelectedId('')
  }}><option value="">Link a note…</option>{notes.map(({ note }) => <option key={note.id} value={note.id}>{note.title || 'Untitled note'}</option>)}</select>
}

function App({ messageTarget = window }: { messageTarget?: EventTarget }) {
  const [open, setOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<DevNotesSettings>(DEFAULT_SETTINGS)
  const [settingsReady, setSettingsReady] = useState(false)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [pageUrl, setPageUrl] = useState(() => normalizePageUrl(location.href))
  const [pageTitle, setPageTitle] = useState(() => document.title || location.hostname)
  const [pages, setPages] = useState<PageNotes>({})
  const [deletedNotes, setDeletedNotes] = useState<Record<string, number>>({})
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionsReady, setCollectionsReady] = useState(false)
  const [addingCollection, setAddingCollection] = useState(false)
  const [collectionDraft, setCollectionDraft] = useState('')
  const [blocklistDraft, setBlocklistDraft] = useState('')
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [orphanedHighlights, setOrphanedHighlights] = useState<string[]>([])
  const [highlightsForUrl, setHighlightsForUrl] = useState('')
  const highlightsRef = useRef(highlights)
  const [showAllNotes, setShowAllNotes] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [showFavorites, setShowFavorites] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sortMode, setSortMode] = useState<'updated' | 'created' | 'title'>('updated')
  const [domainFilter, setDomainFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [bulkSelection, setBulkSelection] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPageUrl, setSelectedPageUrl] = useState(pageUrl)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [importError, setImportError] = useState('')
  const [preview, setPreview] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const initialPageUrlRef = useRef(pageUrl)
  const pagesDirtyRef = useRef(false)
  const pagesVersionRef = useRef(0)
  const highlightsDirtyRef = useRef(false)
  const collectionsDirtyRef = useRef(false)
  const settingsDirtyRef = useRef(false)
  const settingsVersionRef = useRef(0)
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)
  const notes = useMemo(() => pages[pageUrl] ?? [], [pages, pageUrl])
  const selectedNotes = useMemo(() => pages[selectedPageUrl] ?? [], [pages, selectedPageUrl])
  const selected = selectedNotes.find((note) => note.id === selectedId) ?? null
  const hostname = location.hostname.replace(/^www\./, '') || 'This page'
  const darkTheme = settings.theme === 'dark' || (settings.theme === 'system' && systemDark)

  useEffect(() => { highlightsRef.current = highlights }, [highlights])

  useEffect(() => {
    let active = true
    void Promise.all([readPages(), readDeletedNotes()]).then(([saved, deleted]) => {
      if (!active) return
      setDeletedNotes(deleted)
      const visiblePages = removeDeletedPages(saved, deleted)
      setPages(visiblePages)
      setSelectedId(visiblePages[initialPageUrlRef.current]?.[0]?.id ?? null)
      setReady(true)
    })
    void readCollections().then((saved) => { if (active) { setCollections(saved); setCollectionsReady(true) } })
    void readSettings().then((saved) => {
      if (!active) return
      setSettings(saved)
      setSettingsReady(true)
      void readTrash().then((items) => {
        if (!active) return
        const retained = boundedTrash(items, saved.trashRetentionDays)
        setTrash(retained)
        if (retained.length !== items.length) void writeTrash(retained, saved.trashRetentionDays)
      })
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return
    const onStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local') return
      if (changes[SETTINGS_KEY]) {
        const nextSettings = normalizeSettings(changes[SETTINGS_KEY].newValue)
        setSettings(nextSettings)
        if (isHostDisabled(location.hostname, nextSettings)) messageTarget.dispatchEvent(new Event('devnotes-disable-site'))
      }
      if (!changes[STORAGE_KEY] && !changes[DELETED_KEY]) return
      void Promise.all([readPages(), readDeletedNotes()]).then(([incoming, deleted]) => {
        setDeletedNotes(deleted)
        setPages((current) => removeDeletedPages(mergePages(current, incoming), deleted))
      })
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    return () => chrome.storage.onChanged.removeListener(onStorageChanged)
  }, [messageTarget])

  useEffect(() => {
    if (!settingsReady || !settingsDirtyRef.current) return
    const version = settingsVersionRef.current
    const timer = window.setTimeout(() => {
      if (!settingsDirtyRef.current) return
      void writeSettings(settings).then(() => {
        if (version === settingsVersionRef.current) settingsDirtyRef.current = false
      }, () => setSaveState('error'))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [settings, settingsReady])

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextUrl = normalizePageUrl(location.href)
      if (nextUrl === pageUrl) {
        if (document.title !== pageTitle) setPageTitle(document.title || location.hostname)
        return
      }
      setPageUrl(nextUrl)
      setPageTitle(document.title || location.hostname)
      setSelectedPageUrl(nextUrl)
      setSelectedId((pages[nextUrl] ?? [])[0]?.id ?? null)
    }, 750)
    return () => window.clearInterval(interval)
  }, [pageUrl, pageTitle, pages])

  useEffect(() => {
    let active = true
    let observer: MutationObserver | null = null
    let restoreTimer = 0
    clearPageHighlights()
    void readHighlights().then((saved) => {
      if (!active) return
      const pageHighlights = saved[pageUrl] ?? []
      setHighlights(pageHighlights)
      setOrphanedHighlights(applyHighlights(pageHighlights))
      setHighlightsForUrl(pageUrl)
      observer = new MutationObserver((mutations) => {
        const isDevNotesMark = (node: Node) => node instanceof HTMLElement && node.hasAttribute('data-devnotes-highlight')
        const pageChanged = mutations.some((mutation) => !Array.from(mutation.addedNodes).some(isDevNotesMark) && !Array.from(mutation.removedNodes).some(isDevNotesMark))
        if (!pageChanged) return
        window.clearTimeout(restoreTimer)
        restoreTimer = window.setTimeout(() => setOrphanedHighlights(applyHighlights(highlightsRef.current)), 200)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    return () => { active = false; observer?.disconnect(); window.clearTimeout(restoreTimer) }
  }, [pageUrl])

  useEffect(() => {
    if (!collectionsReady || !collectionsDirtyRef.current) return
    collectionsDirtyRef.current = false
    const timer = window.setTimeout(() => { void writeCollections(collections) }, 350)
    return () => window.clearTimeout(timer)
  }, [collections, collectionsReady])

  useEffect(() => {
    if (!ready || highlightsForUrl !== pageUrl || !highlightsDirtyRef.current) return
    highlightsDirtyRef.current = false
    const timer = window.setTimeout(() => {
      void readHighlights().then((saved) => {
        if (highlights.length) saved[pageUrl] = highlights
        else delete saved[pageUrl]
        return writeHighlights(saved)
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [highlights, ready, pageUrl, highlightsForUrl])

  useEffect(() => {
    const toggle = () => setOpen((value) => !value)
    messageTarget.addEventListener('devnotes-toggle', toggle)
    return () => messageTarget.removeEventListener('devnotes-toggle', toggle)
  }, [messageTarget])

  useEffect(() => {
    const onHighlightClick = (event: MouseEvent) => {
      const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-devnotes-highlight]')
      const id = mark?.dataset.devnotesHighlight
      const noteId = highlights.find((item) => item.id === id)?.noteId
      if (!noteId) return
      setShowAllNotes(false)
      setShowArchived(false)
      setSelectedPageUrl(pageUrl)
      setSelectedId(noteId)
      setOpen(true)
    }
    document.addEventListener('click', onHighlightClick)
    return () => document.removeEventListener('click', onHighlightClick)
  }, [highlights, pageUrl])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (open && modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        window.setTimeout(() => searchRef.current?.focus(), 0)
      }
      if (open && event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMac, open])

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!ready || !pagesDirtyRef.current) return
    setSaveState('saving')
    const version = pagesVersionRef.current
    const timer = window.setTimeout(() => {
      void writePages(pages, deletedNotes).then(
        () => { if (version === pagesVersionRef.current) { pagesDirtyRef.current = false; setSaveState('saved') } },
        () => { if (version === pagesVersionRef.current) setSaveState('error') },
      )
    }, 350)
    return () => window.clearTimeout(timer)
  }, [pages, ready, deletedNotes])

  const persist = useCallback((next: PageNotes) => {
    pagesVersionRef.current += 1
    pagesDirtyRef.current = true
    setPages(next)
  }, [])

  const createNote = useCallback((body = '', title = '') => {
    const now = Date.now()
    const note: Note = { id: crypto.randomUUID(), title, body, tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
    persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
    setSelectedPageUrl(pageUrl)
    setSelectedId(note.id)
    return note.id
  }, [pages, persist, pageUrl])

  const updateNote = (field: 'title' | 'body' | 'tags', value: string | string[]) => {
    if (!selected) return
    const history = selected.history ?? []
    const lastRevision = history[history.length - 1]
    const shouldSnapshot = field !== 'tags' && (!lastRevision || Date.now() - lastRevision.savedAt > 30_000)
    const updated: Note = field === 'tags'
      ? { ...selected, tags: value as string[], updatedAt: Date.now() }
      : { ...selected, [field]: value as string, updatedAt: Date.now() }
    if (shouldSnapshot) updated.history = [...history, { id: crypto.randomUUID(), title: selected.title, body: selected.body, savedAt: Date.now() }].slice(-settings.historyDepth)
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? updated : note) })
  }

  const deleteNote = () => {
    if (!selected) return
    const remaining = selectedNotes.filter((note) => note.id !== selected.id)
    persist({ ...pages, [selectedPageUrl]: remaining })
    const deletedNoteId = selected.id
    const nextTrash = boundedTrash([...trash, { note: selected, url: selectedPageUrl, deletedAt: Date.now() }], settings.trashRetentionDays)
    setTrash(nextTrash)
    void writeTrash(nextTrash, settings.trashRetentionDays)
    setDeletedNotes((items) => ({ ...items, [selected.id]: Date.now() }))
    void readHighlights().then((allHighlights) => {
      let changed = false
      for (const url of Object.keys(allHighlights)) {
        const updated = allHighlights[url].filter((item) => item.noteId !== deletedNoteId)
        if (updated.length !== allHighlights[url].length) { allHighlights[url] = updated; changed = true }
      }
      if (changed) void writeHighlights(allHighlights)
      if (selectedPageUrl === pageUrl) {
        document.querySelectorAll<HTMLElement>(`[data-devnotes-highlight]`).forEach((mark) => {
          if (highlights.find((item) => item.noteId === deletedNoteId)?.id === mark.dataset.devnotesHighlight) mark.replaceWith(...Array.from(mark.childNodes))
        })
        setHighlights((items) => items.filter((item) => item.noteId !== deletedNoteId))
        highlightsDirtyRef.current = false
      }
    })
    setSelectedId(remaining[0]?.id ?? null)
  }

  const restoreFromTrash = (entry: TrashEntry) => {
    const restored = { ...entry.note, updatedAt: Date.now() }
    const nextDeleted = { ...deletedNotes }
    delete nextDeleted[entry.note.id]
    setDeletedNotes(nextDeleted)
    persist({ ...pages, [entry.url]: [restored, ...(pages[entry.url] ?? [])] })
    const nextTrash = trash.filter((item) => item.note.id !== entry.note.id)
    setTrash(nextTrash)
    void writeTrash(nextTrash, settings.trashRetentionDays)
    setSelectedPageUrl(entry.url)
    setSelectedId(restored.id)
    setShowTrash(false)
    setShowAllNotes(true)
  }

  const allNotes = useMemo(() => Object.entries(pages).flatMap(([url, items]) => items.map((note) => ({ note, url }))), [pages])
  const availableTags = useMemo(() => [...new Set(allNotes.flatMap(({ note }) => note.tags ?? []))].sort((a, b) => a.localeCompare(b)), [allNotes])
  const backlinks = useMemo(() => selected ? allNotes.filter(({ note }) => note.id !== selected.id && (note.body.toLowerCase().includes(`[[${selected.title.trim().toLowerCase()}]]`) || note.body.includes(`[[id:${selected.id}|`))) : [], [allNotes, selected])
  const filteredNotes = useMemo(() => {
    const source = showAllNotes || deferredQuery.trim() || showTasks ? allNotes : notes.map((note) => ({ note, url: pageUrl }))
    const parsed = parseSearchQuery(deferredQuery)
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : parsed.after
    const to = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : parsed.before
    const matches = source.filter(({ note, url }) => {
      const tags = (note.tags ?? []).map((tag) => tag.toLowerCase())
      const searchable = `${note.title} ${note.body} ${tags.join(' ')} ${url}`.toLowerCase()
      const task = /(?:^|\n)\s*[-*+]\s*\[ \]/.test(note.body)
      const quoted = /^\s*>/m.test(note.body)
      const host = safeHostname(url).toLowerCase()
      return Boolean(note.archived) === showArchived && (!showFavorites || Boolean(note.favorite)) && (!showTasks || task) && (!collectionFilter || note.collectionIds?.includes(collectionFilter)) && (!domainFilter || host.includes(domainFilter.toLowerCase())) && parsed.tags.every((tag) => tags.some((existing) => existing.includes(tag))) && parsed.sites.every((site) => host.includes(site)) && parsed.flags.every((flag) => flag === 'task' ? task : flag === 'favorite' ? Boolean(note.favorite) : flag === 'pinned' ? Boolean(note.pinned) : flag === 'quote' ? quoted : flag === 'archived' ? Boolean(note.archived) : true) && (!from || note.updatedAt >= from) && (!to || note.updatedAt <= to) && parsed.terms.every((term) => fuzzyContains(searchable, term))
    })
    const rank = (note: Note, url: string) => parsed.terms.reduce((score, term) => score + (note.title.toLowerCase().includes(term) ? 8 : note.body.toLowerCase().includes(term) ? 4 : safeHostname(url).toLowerCase().includes(term) ? 3 : 1), 0)
    return matches.sort((a, b) => Number(Boolean(b.note.pinned)) - Number(Boolean(a.note.pinned)) || (parsed.terms.length ? rank(b.note, b.url) - rank(a.note, a.url) : sortMode === 'title' ? a.note.title.localeCompare(b.note.title) : sortMode === 'created' ? b.note.createdAt - a.note.createdAt : b.note.updatedAt - a.note.updatedAt))
  }, [allNotes, notes, pageUrl, deferredQuery, showAllNotes, collectionFilter, showArchived, showFavorites, showTasks, domainFilter, sortMode, dateFrom, dateTo])

  const updateSelected = (patch: Partial<Note>) => {
    if (!selected) return
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? { ...note, ...patch, updatedAt: Date.now() } : note) })
  }

  const restoreRevision = (revision: Revision) => {
    if (!selected) return
    const current: Revision = { id: crypto.randomUUID(), title: selected.title, body: selected.body, savedAt: Date.now() }
    updateSelected({ title: revision.title, body: revision.body, history: [...(selected.history ?? []), current].slice(-settings.historyDepth) })
    setShowHistory(false)
  }

  const openLinkedNote = (title: string) => {
    const match = title.startsWith('id:')
      ? allNotes.find(({ note }) => note.id === title.slice(3))
      : allNotes.find(({ note }) => note.title.trim().toLowerCase() === title.trim().toLowerCase())
    if (!match) return
    setSelectedPageUrl(match.url)
    setSelectedId(match.note.id)
    setShowAllNotes(true)
    setShowArchived(false)
    setShowFavorites(false)
    setShowTasks(false)
    setShowTrash(false)
  }

  const setTaskStatus = (index: number, checked: boolean) => {
    if (!selected) return
    let taskIndex = 0
    const body = selected.body.replace(/^(\s*[-*+]\s+\[)( |x|X)(\])/gm, (line, prefix: string, _state: string, suffix: string) => {
      const current = taskIndex++
      return current === index ? `${prefix}${checked ? 'x' : ' '}${suffix}` : line
    })
    updateNote('body', body)
  }

  const toggleNoteFlag = (noteId: string, field: 'pinned' | 'favorite' | 'archived', url: string) => {
    const target = (pages[url] ?? []).find((note) => note.id === noteId)
    if (!target) return
    const next = { ...pages, [url]: (pages[url] ?? []).map((note) => note.id === noteId ? { ...note, [field]: !note[field], updatedAt: Date.now() } : note) }
    persist(next)
  }

  const bulkUpdate = (transform: (note: Note) => Note) => {
    if (!bulkSelection.length) return
    const selectedIds = new Set(bulkSelection)
    const next = Object.fromEntries(Object.entries(pages).map(([url, items]) => [url, items.map((note) => selectedIds.has(note.id) ? { ...transform(note), updatedAt: Date.now() } : note)]))
    persist(next)
    setBulkSelection([])
  }

  const applyBulkTags = () => {
    const input = window.prompt('Tags to add (comma separated):')
    if (input === null) return
    const additions = input.split(',').map((tag) => tag.trim()).filter(Boolean)
    bulkUpdate((note) => ({ ...note, tags: [...new Map([...(note.tags ?? []), ...additions].map((tag) => [tag.toLowerCase(), tag])).values()] }))
  }

  const createFromTemplate = (template: keyof typeof NOTE_TEMPLATES) => {
    createNote(NOTE_TEMPLATES[template], template)
  }

  const createCollection = () => {
    setAddingCollection(true)
  }

  const updateSettings = (patch: Partial<DevNotesSettings>) => {
    settingsVersionRef.current += 1
    settingsDirtyRef.current = true
    setSettings((current) => normalizeSettings({ ...current, ...patch }))
  }

  const disableOnThisSite = async () => {
    const host = normalizeHost(location.hostname)
    const next = normalizeSettings({
      ...settings,
      disabledHosts: [...settings.disabledHosts.filter((item) => item !== host), host],
      enabledHosts: settings.enabledHosts.filter((item) => item !== host),
    })
    setSettings(next)
    settingsVersionRef.current += 1
    settingsDirtyRef.current = false
    try { await writeSettings(next) } catch {
      setSettings(settings)
      setSaveState('error')
      return
    }
    messageTarget.dispatchEvent(new Event('devnotes-disable-site'))
  }

  const addBlockedHost = (host: string) => {
    const normalized = normalizeHost(host)
    try { if (new URL(`https://${normalized}`).hostname !== normalized) return } catch { return }
    updateSettings({ disabledHosts: [...settings.disabledHosts, normalized], enabledHosts: settings.enabledHosts.filter((item) => item !== normalized) })
  }

  const allowHost = (host: string) => {
    const normalized = normalizeHost(host)
    updateSettings({ enabledHosts: [...settings.enabledHosts, normalized], disabledHosts: settings.disabledHosts.filter((item) => item !== normalized) })
  }

  const saveCollection = () => {
    const name = collectionDraft.trim()
    if (!name) return
    if (collections.some((collection) => collection.name.toLowerCase() === name.toLowerCase())) { setImportError('A collection with that name already exists.'); return }
    collectionsDirtyRef.current = true
    setCollections((items) => [...items, { id: crypto.randomUUID(), name, createdAt: Date.now() }])
    setCollectionDraft('')
    setAddingCollection(false)
  }

  const changeHighlightColor = (id: string, color: string) => {
    highlightsDirtyRef.current = true
    document.querySelectorAll<HTMLElement>(`[data-devnotes-highlight="${CSS.escape(id)}"]`).forEach((mark) => { mark.style.backgroundColor = color })
    setHighlights((items) => items.map((item) => item.id === id ? { ...item, color } : item))
  }

  const removeHighlight = (id: string) => {
    highlightsDirtyRef.current = true
    document.querySelectorAll<HTMLElement>(`[data-devnotes-highlight="${CSS.escape(id)}"]`).forEach((mark) => mark.replaceWith(...Array.from(mark.childNodes)))
    setHighlights((items) => items.filter((item) => item.id !== id))
  }

  const exportMarkdown = () => {
    const markdown = allNotes.map(({ note, url }) => {
      const title = note.title.trim() || 'Untitled note'
      const tags = (note.tags ?? []).length ? `\n\nTags: ${(note.tags ?? []).map((tag) => `\`${tag}\``).join(', ')}` : ''
      return `## ${title}\n\nPage: ${url}\nUpdated: ${new Date(note.updatedAt).toLocaleString()}\n\n${note.body.trim() || '_No content_'}${tags}`
    }).join('\n\n---\n\n')
    const blob = new Blob([`# DevNotes export\n\n${markdown}\n`], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `devnotes-${new Date().toISOString().slice(0, 10)}.md`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const exportJSON = async () => {
    const backup = { format: 'devnotes-backup', version: 1, exportedAt: new Date().toISOString(), pages, collections, highlights: await readHighlights(), trash, settings }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `devnotes-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  const importJSON = async (file?: File) => {
    if (!file) return
    try {
      const backup = validateBackup(JSON.parse(await file.text()))
      if (!backup) { setImportError('That file is not a valid DevNotes backup.'); return }
      const importedPages = backup.pages
      const importedCollections = backup.collections
      const importedSettings = backup.settings ?? settings
      const importedTrash = boundedTrash(backup.trash, importedSettings.trashRetentionDays)
      const importedHighlights = backup.highlights
      clearPageHighlights()
      setPages(importedPages)
      pagesVersionRef.current += 1
      setDeletedNotes({})
      setCollections(importedCollections)
      setTrash(importedTrash)
      setSettings(importedSettings)
      settingsVersionRef.current += 1
      settingsDirtyRef.current = false
      setHighlights(importedHighlights[pageUrl] ?? [])
      highlightsRef.current = importedHighlights[pageUrl] ?? []
      setOrphanedHighlights([])
      setHighlightsForUrl(pageUrl)
      setSelectedPageUrl(pageUrl)
      setSelectedId(importedPages[pageUrl]?.[0]?.id ?? null)
      pagesDirtyRef.current = false
      collectionsDirtyRef.current = false
      highlightsDirtyRef.current = false
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await new Promise<void>((resolve, reject) => chrome.storage.local.set({ [STORAGE_KEY]: importedPages, [DELETED_KEY]: {}, [COLLECTION_KEY]: importedCollections, [TRASH_KEY]: importedTrash, [HIGHLIGHT_KEY]: importedHighlights, [SETTINGS_KEY]: importedSettings }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()))
      } else if (typeof chrome !== 'undefined' && chrome.runtime) {
        throw new Error('Chrome storage is unavailable.')
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(importedPages))
        localStorage.setItem(DELETED_KEY, '{}')
        localStorage.setItem(COLLECTION_KEY, JSON.stringify(importedCollections))
        localStorage.setItem(TRASH_KEY, JSON.stringify(importedTrash))
        localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(importedHighlights))
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(importedSettings))
      }
      setOrphanedHighlights(applyHighlights(importedHighlights[pageUrl] ?? []))
      setImportError('Backup restored.')
    } catch { setImportError('Could not read this backup file.') }
  }

  const captureSelection = useCallback(() => {
    const selection = window.getSelection()
    const text = selection?.toString().trim()
    if (!text || !selection?.rangeCount) { createNote(); return }
    const range = selection.getRangeAt(0)
    const beforeRange = document.createRange()
    beforeRange.selectNodeContents(document.body)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    const start = beforeRange.toString().length
    const pageText = pageTextNodes().map((node) => node.textContent ?? '').join('')
    const item: Highlight = {
      id: crypto.randomUUID(), text,
      prefix: pageText.slice(Math.max(0, start - 24), start),
      suffix: pageText.slice(start + text.length, start + text.length + 24),
      color: settings.highlightColor, createdAt: Date.now(),
    }
    wrapTextOffsets(pageTextNodes(), start, start + text.length, item.id, item.color)
    const quoteJump = `${pageUrl}#:~:text=${encodeURIComponent(text.slice(0, 120))}`
    item.noteId = createNote(`> ${text}\n\nSource: [Jump back to quote](${quoteJump})\n\n`)
    const next = [...highlights, item]
    highlightsDirtyRef.current = true
    setOrphanedHighlights((items) => items.filter((id) => id !== item.id))
    setHighlights(next)
  }, [createNote, highlights, pageUrl, settings.highlightColor])

  const clipArticle = () => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('article, main, [role="main"]'))
      .sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))
    const clone = (candidates[0] ?? document.body).cloneNode(true) as HTMLElement
    clone.querySelectorAll('nav, aside, footer, header, form, button, script, style, noscript, [aria-hidden="true"], [data-devnotes-highlight], #devnotes-root, [class*="advert" i], [id*="advert" i]').forEach((element) => element.remove())
    const content = (clone.innerText || clone.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 24_000)
    const author = document.querySelector<HTMLMetaElement>('meta[name="author"], meta[property="article:author"]')?.content?.trim()
    const published = document.querySelector<HTMLMetaElement>('meta[property="article:published_time"], meta[name="date"], meta[name="publish_date"]')?.content?.trim()
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href
    const metadata = [`# ${pageTitle}`, `Source: ${pageUrl}`, author ? `Author: ${author}` : '', published ? `Published: ${published}` : '', favicon ? `Favicon: ${favicon}` : ''].filter(Boolean).join('\n\n')
    createNote(`${metadata}\n\n---\n\n${content}${content.length >= 24_000 ? '\n\n[Clip shortened to 24,000 characters]' : ''}`, `Clip: ${pageTitle}`)
  }

  useEffect(() => {
    const onCapture = () => { setOpen(true); captureSelection() }
    const onNewNote = () => { setOpen(true); createNote() }
    const onFocusSearch = () => { setOpen(true); window.setTimeout(() => searchRef.current?.focus(), 0) }
    messageTarget.addEventListener('devnotes-capture-selection', onCapture)
    messageTarget.addEventListener('devnotes-new-note', onNewNote)
    messageTarget.addEventListener('devnotes-focus-search', onFocusSearch)
    return () => {
      messageTarget.removeEventListener('devnotes-capture-selection', onCapture)
      messageTarget.removeEventListener('devnotes-new-note', onNewNote)
      messageTarget.removeEventListener('devnotes-focus-search', onFocusSearch)
    }
  }, [captureSelection, createNote, messageTarget])

  return <>
    {!open && !settings.hideLauncher && <button className={`dn-launcher ${settings.launcherPosition === 'bottom-left' ? 'dn-launcher-left' : ''}`} onClick={() => setOpen(true)} aria-label="Open DevNotes" title="DevNotes"><span className="dn-mark">d<span>.</span></span></button>}
    <aside className={`dn-panel ${open ? 'is-open' : ''} ${settings.panelSide === 'left' ? 'dn-panel-left' : ''} ${darkTheme ? 'dn-dark' : ''}`} style={{ width: `min(${settings.panelWidth}px, 100vw)`, left: settings.panelSide === 'left' ? 0 : 'auto', right: settings.panelSide === 'right' ? 0 : 'auto' }} aria-label="DevNotes panel" aria-hidden={!open}>
      <header className="dn-header">
        <div className="dn-brand"><span className="dn-brand-icon">d<span>.</span></span><span>devnotes</span></div>
        <button className="dn-icon-button dn-site-disable" onClick={() => void disableOnThisSite()} aria-label={`Disable DevNotes on ${hostname}`} title="Disable on this site">◉</button>
        <button className="dn-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open DevNotes settings" title="Settings">⚙</button>
        <button className="dn-icon-button" onClick={() => setOpen(false)} aria-label="Close panel">×</button>
      </header>
      {settingsOpen && <section className="dn-settings" role="dialog" aria-label="DevNotes settings"><div className="dn-settings-heading"><div><strong>Settings</strong><span>Preferences are stored on this device.</span></div><button className="dn-icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div><div className="dn-settings-content"><label>Theme<select value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as DevNotesSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Panel side<select value={settings.panelSide} onChange={(event) => updateSettings({ panelSide: event.target.value as DevNotesSettings['panelSide'] })}><option value="right">Right</option><option value="left">Left</option></select></label><label>Panel width <span>{settings.panelWidth}px</span><input type="range" min="360" max="720" step="10" value={settings.panelWidth} onChange={(event) => updateSettings({ panelWidth: Number(event.target.value) })} /></label><label>Launcher position<select value={settings.launcherPosition} onChange={(event) => updateSettings({ launcherPosition: event.target.value as DevNotesSettings['launcherPosition'] })}><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select></label><label className="dn-settings-check"><input type="checkbox" checked={settings.hideLauncher} onChange={(event) => updateSettings({ hideLauncher: event.target.checked })} />Hide the floating launcher</label><fieldset><legend>Default highlight color</legend><div className="dn-setting-colors">{HIGHLIGHT_COLORS.map((color) => <button key={color} type="button" className={settings.highlightColor === color ? 'selected' : ''} style={{ background: color }} aria-label={`Use highlight color ${color}`} onClick={() => updateSettings({ highlightColor: color })} />)}</div></fieldset><label>Trash retention <span>{settings.trashRetentionDays} days</span><input type="range" min="30" max="3650" step="30" value={settings.trashRetentionDays} onChange={(event) => updateSettings({ trashRetentionDays: Number(event.target.value) })} /></label><label>Version history <span>{settings.historyDepth} versions</span><input type="range" min="1" max="100" value={settings.historyDepth} onChange={(event) => updateSettings({ historyDepth: Number(event.target.value) })} /></label><div className="dn-site-settings"><strong>This site · {hostname}</strong><button onClick={() => void disableOnThisSite()}>Disable DevNotes on this site</button></div><form className="dn-blocklist-add" onSubmit={(event) => { event.preventDefault(); addBlockedHost(blocklistDraft); setBlocklistDraft('') }}><label htmlFor="dn-block-host">Block another site</label><div><input id="dn-block-host" value={blocklistDraft} onChange={(event) => setBlocklistDraft(event.target.value)} placeholder="example.com" /><button type="submit">Add</button></div></form><div className="dn-blocklist"><strong>Blocked sites</strong>{settings.disabledHosts.length ? settings.disabledHosts.map((host) => <div key={host}><span>{host}</span><button aria-label={`Unblock ${host}`} onClick={() => allowHost(host)}>Allow</button></div>) : <small>No custom sites blocked.</small>}<strong>Default protected sites</strong>{DEFAULT_BLOCKED_HOSTS.map((host) => { const allowed = settings.enabledHosts.some((rule) => hostMatches(hostname, rule)) && hostMatches(hostname, host); return <div key={host}><span>{host}</span><button aria-label={`${allowed ? 'Block' : 'Allow'} DevNotes on ${host}`} onClick={() => allowed ? addBlockedHost(host) : allowHost(host)}>{allowed ? 'Block' : 'Allow'}</button></div> })}</div></div></section>}
      <div className="dn-page"><div className="dn-site-icon">{hostname[0]?.toUpperCase()}</div><div className="dn-page-copy"><strong>{hostname}</strong><span title={pageTitle}>{pageTitle}</span></div><button className="dn-clip" title="Clip the main article" onClick={clipArticle}>Clip</button><button className="dn-icon-button dn-more" title="Highlight selection and save as a note" aria-label="Capture selected text" onClick={captureSelection}>✳</button></div>
      {highlights.length > 0 && <div className="dn-highlights"><strong>Page highlights · {highlights.length}</strong>{highlights.map((item) => <div className="dn-highlight-row" key={item.id}><button className="dn-highlight-quote" onClick={() => { document.querySelector<HTMLElement>(`[data-devnotes-highlight="${CSS.escape(item.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (item.noteId) { setSelectedPageUrl(pageUrl); setSelectedId(item.noteId) } }}>{item.text.slice(0, 45)}{item.text.length > 45 ? '…' : ''}</button>{orphanedHighlights.includes(item.id) && <span className="dn-orphan-badge">Not found</span>}<div className="dn-highlight-tools"><button title="Yellow" aria-label="Set highlight color to yellow" style={{ background: '#f6e58d' }} onClick={() => changeHighlightColor(item.id, '#f6e58d')} /><button title="Green" aria-label="Set highlight color to green" style={{ background: '#c8e6a0' }} onClick={() => changeHighlightColor(item.id, '#c8e6a0')} /><button title="Blue" aria-label="Set highlight color to blue" style={{ background: '#b7dff2' }} onClick={() => changeHighlightColor(item.id, '#b7dff2')} /><button title="Pink" aria-label="Set highlight color to pink" style={{ background: '#f2c5d2' }} onClick={() => changeHighlightColor(item.id, '#f2c5d2')} /><button className="dn-highlight-remove" title="Remove highlight" onClick={() => removeHighlight(item.id)}>×</button></div></div>)}</div>}
      <div className="dn-dashboard-tabs"><button className={!showAllNotes && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(false); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false); setCollectionFilter('') }}>This page</button><button className={showAllNotes && !showArchived && !showFavorites && !showTasks && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>All notes</button><button className={showTasks ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(true); setShowTrash(false) }}>Tasks</button><button className={showFavorites ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(true); setShowTasks(false); setShowTrash(false) }}>Favorites</button><button className={showArchived ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(true); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>Archived</button><button className={showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowTrash(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false) }}>Trash</button></div>
      <div className="dn-page-heading"><h1>{showTrash ? 'Trash' : showArchived ? 'Archived' : showTasks ? 'Tasks' : showFavorites ? 'Favorites' : showAllNotes ? 'All notes' : 'Page notes'} <span>{showTrash ? trash.length : showArchived ? allNotes.filter(({ note }) => note.archived).length : showTasks ? allNotes.filter(({ note }) => !note.archived && /(?:^|\n)\s*[-*+]\s*\[ \]/.test(note.body)).length : showFavorites ? allNotes.filter(({ note }) => note.favorite && !note.archived).length : showAllNotes ? allNotes.filter(({ note }) => !note.archived).length : notes.filter((note) => !note.archived).length}</span></h1><div className="dn-heading-actions"><button className="dn-export" onClick={exportMarkdown} disabled={!allNotes.length} title="Export all notes as Markdown">MD</button><button className="dn-export" onClick={() => void exportJSON()} title="Export JSON backup">Backup</button><button className="dn-export" onClick={() => importRef.current?.click()} title="Import JSON backup">Import</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importJSON(event.target.files?.[0]); event.currentTarget.value = '' }} /><select className="dn-template-select" aria-label="Create note from template" value="" onChange={(event) => { if (event.target.value) createFromTemplate(event.target.value as keyof typeof NOTE_TEMPLATES) }}><option value="">Template…</option>{Object.keys(NOTE_TEMPLATES).map((name) => <option key={name} value={name}>{name}</option>)}</select><button className="dn-new" onClick={() => createNote()}><b>＋</b> New note</button></div></div>
      {showAllNotes && <div className="dn-collection-bar"><select aria-label="Filter by collection" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">All collections</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><input className="dn-domain-filter" aria-label="Filter by website domain" placeholder="Domain" value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} /><select aria-label="Sort notes" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="updated">Updated</option><option value="created">Created</option><option value="title">Title</option></select><input aria-label="Updated after" title="Updated after" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /><input aria-label="Updated before" title="Updated before" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /><button className="dn-collection-add" onClick={createCollection}>＋</button></div>}
      {showAllNotes && availableTags.length > 0 && <div className="dn-tag-browser"><strong>Tags</strong>{availableTags.map((tag) => <button key={tag} onClick={() => setQuery((value) => `${value} tag:"${tag}"`.trim())}>{tag}</button>)}</div>}
      {showAllNotes && bulkSelection.length > 0 && <div className="dn-bulk-actions"><strong>{bulkSelection.length} selected</strong><button onClick={applyBulkTags}>Add tags</button><button onClick={() => bulkUpdate((note) => ({ ...note, archived: true }))}>Archive</button><button onClick={() => setBulkSelection([])}>Clear</button></div>}
      {addingCollection && <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); saveCollection() }}><input autoFocus aria-label="Collection name" placeholder="Collection name" value={collectionDraft} onChange={(event) => setCollectionDraft(event.target.value)} /><button type="submit">Create</button><button type="button" onClick={() => { setAddingCollection(false); setCollectionDraft('') }}>Cancel</button></form>}
      <label className="dn-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8"/><path d="m13.2 13.2 4 4"/></svg><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" /><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd></label>
      {importError && <div className="dn-import-status" role="status">{importError}<button aria-label="Dismiss message" onClick={() => setImportError('')}>×</button></div>}
      {!ready ? <div className="dn-empty">Loading your notes…</div> : showTrash ? <div className="dn-trash-list">{trash.length ? trash.map((entry) => <div className="dn-trash-row" key={entry.note.id}><span><strong>{entry.note.title || 'Untitled note'}</strong><small>{safeHostname(entry.url)}</small></span><button className="dn-preview-toggle" onClick={() => restoreFromTrash(entry)}>Restore</button><button className="dn-delete" onClick={() => { const next = trash.filter((item) => item.note.id !== entry.note.id); setTrash(next); void writeTrash(next) }}>Delete forever</button></div>) : <div className="dn-empty">Trash is empty.</div>}</div> : !showAllNotes && notes.length === 0 && !query.trim() ? <div className="dn-empty-state"><div className="dn-empty-icon">✎</div><strong>A fresh page to think on.</strong><p>Keep the useful bits, questions, and ideas you find here.</p><button onClick={() => createNote()}>Write your first note <span>→</span></button><div className="dn-hint">TIP · SELECT TEXT ON THE PAGE, THEN TAP ✳</div></div> : filteredNotes.length === 0 ? <div className="dn-empty">{query.trim() ? `No notes match “${query}”.` : 'No notes here yet.'}</div> : <div className="dn-content">
        <div className="dn-note-list">{filteredNotes.map(({ note, url }) => <div key={`${url}:${note.id}`} className={`dn-note-row-wrap ${selectedPageUrl === url && selectedId === note.id ? 'active' : ''}`}>{showAllNotes && <input className="dn-bulk-check" type="checkbox" aria-label={`Select ${note.title || 'Untitled note'}`} checked={bulkSelection.includes(note.id)} onChange={(event) => setBulkSelection((ids) => event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id))} />}<button className="dn-note-row" onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}><span className="dn-note-dot"/><span className="dn-note-row-text"><strong>{note.pinned ? '📌 ' : ''}<SearchMatch text={note.title || 'Untitled note'} query={query} /></strong><small>{showAllNotes || query ? safeHostname(url) + ' · ' : ''}{note.body.trim().replace(/^>\s?/gm, '').slice(0, 58) || 'No content yet'}</small></span></button><button className={`dn-row-action ${note.favorite ? 'selected' : ''}`} title={note.favorite ? 'Remove favorite' : 'Add favorite'} aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleNoteFlag(note.id, 'favorite', url)}>{note.favorite ? '♥' : '♡'}</button><button className="dn-row-action" title={note.archived ? 'Restore from archive' : 'Archive note'} aria-label={note.archived ? 'Restore note' : 'Archive note'} onClick={() => toggleNoteFlag(note.id, 'archived', url)}>{note.archived ? '↶' : '▱'}</button></div>)}</div>
        {selected ? <article className="dn-editor"><div className="dn-editor-top"><span className="dn-note-type">NOTE</span><div className="dn-editor-actions"><button className={`dn-preview-toggle ${selected.pinned ? 'active' : ''}`} onClick={() => updateSelected({ pinned: !selected.pinned })}>{selected.pinned ? 'Unpin' : 'Pin'}</button><button className={`dn-preview-toggle ${selected.favorite ? 'active' : ''}`} onClick={() => updateSelected({ favorite: !selected.favorite })}>{selected.favorite ? '♥ Favorite' : '♡ Favorite'}</button><button className="dn-preview-toggle" onClick={() => setShowHistory((value) => !value)}>History</button><button className={`dn-preview-toggle ${preview ? 'active' : ''}`} onClick={() => setPreview((value) => !value)} aria-pressed={preview}>{preview ? 'Edit' : 'Preview'}</button><button className="dn-delete" onClick={deleteNote} title="Move note to trash">Delete</button></div></div><input className="dn-title" placeholder="Give this note a title…" value={selected.title} onChange={(event) => updateNote('title', event.target.value)} />{showHistory && <div className="dn-history-list">{(selected.history ?? []).length ? [...(selected.history ?? [])].reverse().map((revision) => <button key={revision.id} onClick={() => restoreRevision(revision)}><strong>{revision.title || 'Untitled note'}</strong><small>{new Date(revision.savedAt).toLocaleString()} · Restore</small></button>) : <small>No saved versions yet. Versions are captured during editing.</small>}</div>}{preview ? <div className="dn-markdown-preview" onChange={(event) => { const input = event.target as HTMLInputElement; if (input.matches('input[data-task-index]')) setTaskStatus(Number(input.dataset.taskIndex), input.checked) }} onClick={(event) => { const target = event.target as HTMLElement; const copy = target.closest<HTMLButtonElement>('[data-copy-code]'); if (copy) { const code = copy.parentElement?.querySelector('code')?.textContent ?? ''; void navigator.clipboard?.writeText(code).then(() => { copy.textContent = 'Copied' }) } const anchor = target.closest('a'); const href = anchor?.getAttribute('href'); if (href?.startsWith('#devnotes-note-id-')) { event.preventDefault(); openLinkedNote('id:' + decodeURIComponent(href.slice('#devnotes-note-id-'.length))) } else if (href?.startsWith('#devnotes-note-')) { event.preventDefault(); openLinkedNote(decodeURIComponent(href.slice('#devnotes-note-'.length))) } }} dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(selected.body || '*Nothing to preview yet.*') }} /> : <textarea className="dn-body" placeholder="Start writing…" value={selected.body} onChange={(event) => updateNote('body', event.target.value)} />}<LinkNoteInput notes={allNotes.filter(({ note }) => note.id !== selected.id)} onLink={(id, title) => updateNote('body', `${selected.body}\n[[id:${id}|${title}]]`)} /><div className="dn-collection-assign">{collections.length ? collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={selected.collectionIds?.includes(collection.id) ?? false} onChange={(event) => { const ids = selected.collectionIds ?? []; updateSelected({ collectionIds: event.target.checked ? [...ids, collection.id] : ids.filter((id) => id !== collection.id) }) }} />{collection.name}</label>) : <button className="dn-collection-add" onClick={createCollection}>＋ Create a collection</button>}</div><TagInput key={selected.id} tags={selected.tags ?? []} onCommit={(tags) => updateNote('tags', tags)} />{backlinks.length > 0 && <div className="dn-backlinks"><strong>Linked from</strong>{backlinks.map(({ note, url }) => <button key={note.id} onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}>{note.title || 'Untitled note'}</button>)}</div>}<div className="dn-editor-footer"><span><i/>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed · try editing again' : 'Saved locally'}</span></div></article> : null}
      </div>}
    </aside>
  </>
}

export default App
