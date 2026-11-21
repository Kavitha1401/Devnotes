import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

type Note = { id: string; title: string; body: string; tags?: string[]; collectionIds?: string[]; pinned?: boolean; favorite?: boolean; archived?: boolean; history?: Revision[]; createdAt: number; updatedAt: number }
type Revision = { id: string; title: string; body: string; savedAt: number }
type PageNotes = Record<string, Note[]>
type Collection = { id: string; name: string; createdAt: number }
type Highlight = { id: string; noteId?: string; text: string; prefix: string; suffix: string; color: string; createdAt: number }
type TrashEntry = { note: Note; url: string; deletedAt: number }

const STORAGE_KEY = 'devnotes-pages'
const HIGHLIGHT_KEY = 'devnotes-highlights'
const COLLECTION_KEY = 'devnotes-collections'
const TRASH_KEY = 'devnotes-trash'
const pageUrl = (() => {
  const url = new URL(location.href)
  url.hash = ''
  // Tracking parameters do not make a page a different note destination.
  const trackingKeys: string[] = []
  url.searchParams.forEach((_value, key) => { if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) trackingKeys.push(key) })
  for (const key of trackingKeys) {
    if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.toString().replace(/\/$/, '')
})()

function migratePages(value: PageNotes): PageNotes {
  return Object.fromEntries(Object.entries(value).map(([url, notes]) => [url, notes.map((note) => ({
    ...note,
    tags: Array.isArray(note.tags) ? note.tags : [],
    collectionIds: Array.isArray(note.collectionIds) ? note.collectionIds : [],
    pinned: Boolean(note.pinned),
    favorite: Boolean(note.favorite),
    archived: Boolean(note.archived),
  }))]))
}

function readPages(): Promise<PageNotes> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(STORAGE_KEY, (result) => resolve(migratePages((result[STORAGE_KEY] as PageNotes | undefined) ?? {})))
      return
    }
    try { resolve(migratePages(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))) } catch { resolve({}) }
  })
}

function writePages(pages: PageNotes): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: pages }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

function readHighlights(): Promise<Record<string, Highlight[]>> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(HIGHLIGHT_KEY, (result) => resolve((result[HIGHLIGHT_KEY] as Record<string, Highlight[]> | undefined) ?? {}))
      return
    }
    try { resolve(JSON.parse(localStorage.getItem(HIGHLIGHT_KEY) ?? '{}')) } catch { resolve({}) }
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
    try { localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(highlights)); resolve() } catch (error) { reject(error) }
  })
}

function readCollections(): Promise<Collection[]> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(COLLECTION_KEY, (result) => resolve((result[COLLECTION_KEY] as Collection[] | undefined) ?? []))
      return
    }
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
    try { localStorage.setItem(COLLECTION_KEY, JSON.stringify(collections)); resolve() } catch (error) { reject(error) }
  })
}

function readTrash(): Promise<TrashEntry[]> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(TRASH_KEY, (result) => resolve((result[TRASH_KEY] as TrashEntry[] | undefined) ?? []))
      return
    }
    try { resolve(JSON.parse(localStorage.getItem(TRASH_KEY) ?? '[]')) } catch { resolve([]) }
  })
}

function writeTrash(trash: TrashEntry[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [TRASH_KEY]: trash }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(trash)); resolve() } catch (error) { reject(error) }
  })
}

function applyHighlights(highlights: Highlight[]) {
  if (!highlights.length || !document.body) return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!node.textContent?.trim() || parent?.closest('script, style, noscript, textarea, input, [data-devnotes-highlight], #devnotes-root')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  for (const item of highlights) {
    const match = textNodes.find((node) => {
      const value = node.textContent ?? ''
      const index = value.indexOf(item.text)
      if (index < 0) return false
      const before = value.slice(Math.max(0, index - item.prefix.length), index)
      const after = value.slice(index + item.text.length, index + item.text.length + item.suffix.length)
      return (!item.prefix || before.endsWith(item.prefix)) && (!item.suffix || after.startsWith(item.suffix))
    })
    if (!match) continue
    const index = (match.textContent ?? '').indexOf(item.text)
    const range = document.createRange()
    range.setStart(match, index)
    range.setEnd(match, index + item.text.length)
    const mark = document.createElement('mark')
    mark.dataset.devnotesHighlight = item.id
    mark.style.cssText = `background:${item.color}; color:inherit; border-radius:2px; padding:0 1px;`
    try { range.surroundContents(mark) } catch { /* Skip selections crossing complex inline markup. */ }
  }
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

function App() {
  const [open, setOpen] = useState(false)
  const [pages, setPages] = useState<PageNotes>({})
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionsReady, setCollectionsReady] = useState(false)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [showAllNotes, setShowAllNotes] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [showFavorites, setShowFavorites] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sortMode, setSortMode] = useState<'updated' | 'created' | 'title'>('updated')
  const [domainFilter, setDomainFilter] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPageUrl, setSelectedPageUrl] = useState(pageUrl)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [preview, setPreview] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const notes = pages[pageUrl] ?? []
  const selectedNotes = pages[selectedPageUrl] ?? []
  const selected = selectedNotes.find((note) => note.id === selectedId) ?? null
  const hostname = location.hostname.replace(/^www\./, '') || 'This page'
  const pageTitle = document.title || hostname

  useEffect(() => {
    let active = true
    void readPages().then((saved) => {
      if (!active) return
      setPages(saved)
      setSelectedId(saved[pageUrl]?.[0]?.id ?? null)
      setReady(true)
    })
    void readHighlights().then((saved) => {
      if (!active) return
      const pageHighlights = saved[pageUrl] ?? []
      setHighlights(pageHighlights)
      applyHighlights(pageHighlights)
    })
    void readCollections().then((saved) => { if (active) { setCollections(saved); setCollectionsReady(true) } })
    void readTrash().then((saved) => { if (active) setTrash(saved) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!collectionsReady) return
    const timer = window.setTimeout(() => { void writeCollections(collections) }, 350)
    return () => window.clearTimeout(timer)
  }, [collections, collectionsReady])

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => {
      void readHighlights().then((saved) => writeHighlights({ ...saved, [pageUrl]: highlights }))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [highlights, ready])

  useEffect(() => {
    const toggle = () => setOpen((value) => !value)
    window.addEventListener('devnotes-toggle', toggle)
    return () => window.removeEventListener('devnotes-toggle', toggle)
  }, [])

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
  }, [highlights])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setOpen((value) => !value)
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
        window.setTimeout(() => searchRef.current?.focus(), 0)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMac])

  useEffect(() => {
    if (!ready) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      void writePages(pages).then(
        () => setSaveState('saved'),
        () => setSaveState('error'),
      )
    }, 350)
    return () => window.clearTimeout(timer)
  }, [pages, ready])

  const persist = useCallback((next: PageNotes) => {
    setPages(next)
  }, [])

  const createNote = useCallback((body = '', title = '') => {
    const now = Date.now()
    const note: Note = { id: crypto.randomUUID(), title, body, tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
    persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
    setSelectedPageUrl(pageUrl)
    setSelectedId(note.id)
    return note.id
  }, [pages, persist])

  const updateNote = (field: 'title' | 'body' | 'tags', value: string | string[]) => {
    if (!selected) return
    const history = selected.history ?? []
    const lastRevision = history[history.length - 1]
    const shouldSnapshot = field !== 'tags' && (!lastRevision || Date.now() - lastRevision.savedAt > 30_000)
    const updated: Note = field === 'tags'
      ? { ...selected, tags: value as string[], updatedAt: Date.now() }
      : { ...selected, [field]: value as string, updatedAt: Date.now() }
    if (shouldSnapshot) updated.history = [...history, { id: crypto.randomUUID(), title: selected.title, body: selected.body, savedAt: Date.now() }].slice(-20)
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? updated : note) })
  }

  const deleteNote = () => {
    if (!selected) return
    const remaining = selectedNotes.filter((note) => note.id !== selected.id)
    persist({ ...pages, [selectedPageUrl]: remaining })
    const nextTrash = [...trash, { note: selected, url: selectedPageUrl, deletedAt: Date.now() }]
    setTrash(nextTrash)
    void writeTrash(nextTrash)
    setSelectedId(remaining[0]?.id ?? null)
  }

  const restoreFromTrash = (entry: TrashEntry) => {
    persist({ ...pages, [entry.url]: [entry.note, ...(pages[entry.url] ?? [])] })
    const nextTrash = trash.filter((item) => item.note.id !== entry.note.id)
    setTrash(nextTrash)
    void writeTrash(nextTrash)
    setSelectedPageUrl(entry.url)
    setSelectedId(entry.note.id)
    setShowTrash(false)
    setShowAllNotes(true)
  }

  const allNotes = useMemo(() => Object.entries(pages).flatMap(([url, items]) => items.map((note) => ({ note, url }))), [pages])
  const backlinks = useMemo(() => selected?.title.trim() ? allNotes.filter(({ note }) => note.id !== selected.id && note.body.toLowerCase().includes(`[[${selected.title.trim().toLowerCase()}]]`)) : [], [allNotes, selected])
  const filteredNotes = useMemo(() => {
    const source = showAllNotes || query.trim() || showTasks ? allNotes : notes.map((note) => ({ note, url: pageUrl }))
    const needle = query.trim().toLowerCase()
    return source.filter(({ note, url }) => Boolean(note.archived) === showArchived && (!showFavorites || Boolean(note.favorite)) && (!showTasks || /(?:^|\n)\s*[-*+]\s*\[ \]/.test(note.body)) && (!collectionFilter || note.collectionIds?.includes(collectionFilter)) && (!domainFilter || new URL(url).hostname.includes(domainFilter.toLowerCase())) && (!needle || `${note.title} ${note.body} ${(note.tags ?? []).join(' ')} ${url}`.toLowerCase().includes(needle)))
      .sort((a, b) => Number(Boolean(b.note.pinned)) - Number(Boolean(a.note.pinned)) || (sortMode === 'title' ? a.note.title.localeCompare(b.note.title) : sortMode === 'created' ? b.note.createdAt - a.note.createdAt : b.note.updatedAt - a.note.updatedAt))
  }, [allNotes, notes, query, showAllNotes, collectionFilter, showArchived, showFavorites, showTasks, domainFilter, sortMode])

  const updateSelected = (patch: Partial<Note>) => {
    if (!selected) return
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? { ...note, ...patch, updatedAt: Date.now() } : note) })
  }

  const restoreRevision = (revision: Revision) => {
    if (!selected) return
    const current: Revision = { id: crypto.randomUUID(), title: selected.title, body: selected.body, savedAt: Date.now() }
    updateSelected({ title: revision.title, body: revision.body, history: [...(selected.history ?? []), current].slice(-20) })
    setShowHistory(false)
  }

  const openLinkedNote = (title: string) => {
    const match = allNotes.find(({ note }) => note.title.trim().toLowerCase() === title.trim().toLowerCase())
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

  const createCollection = () => {
    const name = window.prompt('Collection name')?.trim()
    if (name && !collections.some((collection) => collection.name.toLowerCase() === name.toLowerCase())) {
      setCollections((items) => [...items, { id: crypto.randomUUID(), name, createdAt: Date.now() }])
    }
  }

  const changeHighlightColor = (id: string, color: string) => {
    document.querySelectorAll<HTMLElement>(`[data-devnotes-highlight="${CSS.escape(id)}"]`).forEach((mark) => { mark.style.backgroundColor = color })
    setHighlights((items) => items.map((item) => item.id === id ? { ...item, color } : item))
  }

  const removeHighlight = (id: string) => {
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
    const backup = { format: 'devnotes-backup', version: 1, exportedAt: new Date().toISOString(), pages, collections, highlights: await readHighlights(), trash }
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
      const data = JSON.parse(await file.text()) as { format?: string; pages?: PageNotes; collections?: Collection[]; highlights?: Record<string, Highlight[]>; trash?: TrashEntry[] }
      if (data.format !== 'devnotes-backup' || !data.pages || typeof data.pages !== 'object' || !window.confirm('Replace your current DevNotes data with this backup?')) return
      const importedPages = migratePages(data.pages)
      const importedCollections = Array.isArray(data.collections) ? data.collections : []
      const importedTrash = Array.isArray(data.trash) ? data.trash : []
      const importedHighlights = data.highlights && typeof data.highlights === 'object' ? data.highlights : {}
      setPages(importedPages)
      setCollections(importedCollections)
      setTrash(importedTrash)
      setHighlights(importedHighlights[pageUrl] ?? [])
      setSelectedPageUrl(pageUrl)
      setSelectedId(importedPages[pageUrl]?.[0]?.id ?? null)
      await Promise.all([writePages(importedPages), writeCollections(importedCollections), writeTrash(importedTrash), writeHighlights(importedHighlights)])
      applyHighlights(importedHighlights[pageUrl] ?? [])
    } catch {
      window.alert('That file is not a valid DevNotes JSON backup.')
    }
  }

  const captureSelection = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim()
    if (!text || !selection?.rangeCount) { createNote(); return }
    const range = selection.getRangeAt(0)
    const context = range.startContainer.textContent ?? ''
    const start = range.startOffset
    const item: Highlight = {
      id: crypto.randomUUID(), text,
      prefix: context.slice(Math.max(0, start - 24), start),
      suffix: context.slice(start + text.length, start + text.length + 24),
      color: '#f6e58d', createdAt: Date.now(),
    }
    const mark = document.createElement('mark')
    mark.dataset.devnotesHighlight = item.id
    mark.style.cssText = `background:${item.color}; color:inherit; border-radius:2px; padding:0 1px;`
    try { range.surroundContents(mark) } catch { /* The quote is still saved when the selection crosses inline elements. */ }
    item.noteId = createNote(`> ${text}\n\n`)
    const next = [...highlights, item]
    setHighlights(next)
  }

  const clipArticle = () => {
    const main = document.querySelector<HTMLElement>('article, main, [role="main"]')
    const content = (main?.innerText || document.body.innerText).trim().slice(0, 24_000)
    createNote(`${content}${content.length >= 24_000 ? '\n\n[Clip shortened to 24,000 characters]' : ''}\n\nSource: ${location.href}`, `Clip: ${pageTitle}`)
  }

  useEffect(() => {
    const onCapture = () => { setOpen(true); captureSelection() }
    const onNewNote = () => { setOpen(true); createNote() }
    window.addEventListener('devnotes-capture-selection', onCapture)
    window.addEventListener('devnotes-new-note', onNewNote)
    return () => {
      window.removeEventListener('devnotes-capture-selection', onCapture)
      window.removeEventListener('devnotes-new-note', onNewNote)
    }
  }, [createNote, highlights])

  return <>
    {!open && <button className="dn-launcher" onClick={() => setOpen(true)} aria-label="Open DevNotes" title="DevNotes"><span className="dn-mark">d<span>.</span></span></button>}
    <aside className={`dn-panel ${open ? 'is-open' : ''}`} aria-label="DevNotes panel" aria-hidden={!open}>
      <header className="dn-header">
        <div className="dn-brand"><span className="dn-brand-icon">d<span>.</span></span><span>devnotes</span></div>
        <button className="dn-icon-button" onClick={() => setOpen(false)} aria-label="Close panel">×</button>
      </header>
      <div className="dn-page"><div className="dn-site-icon">{hostname[0]?.toUpperCase()}</div><div className="dn-page-copy"><strong>{hostname}</strong><span title={pageTitle}>{pageTitle}</span></div><button className="dn-clip" title="Clip the main article" onClick={clipArticle}>Clip</button><button className="dn-icon-button dn-more" title="Highlight selection and save as a note" onClick={captureSelection}>✳</button></div>
      {highlights.length > 0 && <div className="dn-highlights"><strong>Page highlights · {highlights.length}</strong>{highlights.map((item) => <div className="dn-highlight-row" key={item.id}><button className="dn-highlight-quote" onClick={() => { if (item.noteId) { setSelectedPageUrl(pageUrl); setSelectedId(item.noteId) } }}>{item.text.slice(0, 45)}{item.text.length > 45 ? '…' : ''}</button><div className="dn-highlight-tools"><button title="Yellow" style={{ background: '#f6e58d' }} onClick={() => changeHighlightColor(item.id, '#f6e58d')} /><button title="Green" style={{ background: '#c8e6a0' }} onClick={() => changeHighlightColor(item.id, '#c8e6a0')} /><button title="Blue" style={{ background: '#b7dff2' }} onClick={() => changeHighlightColor(item.id, '#b7dff2')} /><button title="Pink" style={{ background: '#f2c5d2' }} onClick={() => changeHighlightColor(item.id, '#f2c5d2')} /><button className="dn-highlight-remove" title="Remove highlight" onClick={() => removeHighlight(item.id)}>×</button></div></div>)}</div>}
      <div className="dn-dashboard-tabs"><button className={!showAllNotes && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(false); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false); setCollectionFilter('') }}>This page</button><button className={showAllNotes && !showArchived && !showFavorites && !showTasks && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>All notes</button><button className={showTasks ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(true); setShowTrash(false) }}>Tasks</button><button className={showFavorites ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(true); setShowTasks(false); setShowTrash(false) }}>Favorites</button><button className={showArchived ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(true); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>Archived</button><button className={showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowTrash(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false) }}>Trash</button></div>
      <div className="dn-page-heading"><h1>{showTrash ? 'Trash' : showArchived ? 'Archived' : showTasks ? 'Tasks' : showFavorites ? 'Favorites' : showAllNotes ? 'All notes' : 'Page notes'} <span>{showTrash ? trash.length : showArchived ? allNotes.filter(({ note }) => note.archived).length : showTasks ? allNotes.filter(({ note }) => !note.archived && /(?:^|\n)\s*[-*+]\s*\[ \]/.test(note.body)).length : showFavorites ? allNotes.filter(({ note }) => note.favorite && !note.archived).length : showAllNotes ? allNotes.filter(({ note }) => !note.archived).length : notes.filter((note) => !note.archived).length}</span></h1><div className="dn-heading-actions"><button className="dn-export" onClick={exportMarkdown} disabled={!allNotes.length} title="Export all notes as Markdown">MD</button><button className="dn-export" onClick={() => void exportJSON()} title="Export JSON backup">Backup</button><button className="dn-export" onClick={() => importRef.current?.click()} title="Import JSON backup">Import</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importJSON(event.target.files?.[0]); event.currentTarget.value = '' }} /><button className="dn-new" onClick={() => createNote()}><b>＋</b> New note</button></div></div>
      {showAllNotes && <div className="dn-collection-bar"><select aria-label="Filter by collection" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">All collections</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><input className="dn-domain-filter" aria-label="Filter by website domain" placeholder="Domain" value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} /><select aria-label="Sort notes" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="updated">Updated</option><option value="created">Created</option><option value="title">Title</option></select><button className="dn-collection-add" onClick={createCollection}>＋</button></div>}
      <label className="dn-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8"/><path d="m13.2 13.2 4 4"/></svg><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" /><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd></label>
      {!ready ? <div className="dn-empty">Loading your notes…</div> : showTrash ? <div className="dn-trash-list">{trash.length ? trash.map((entry) => <div className="dn-trash-row" key={entry.note.id}><span><strong>{entry.note.title || 'Untitled note'}</strong><small>{new URL(entry.url).hostname}</small></span><button className="dn-preview-toggle" onClick={() => restoreFromTrash(entry)}>Restore</button><button className="dn-delete" onClick={() => { const next = trash.filter((item) => item.note.id !== entry.note.id); setTrash(next); void writeTrash(next) }}>Delete forever</button></div>) : <div className="dn-empty">Trash is empty.</div>}</div> : !showAllNotes && notes.length === 0 && !query.trim() ? <div className="dn-empty-state"><div className="dn-empty-icon">✎</div><strong>A fresh page to think on.</strong><p>Keep the useful bits, questions, and ideas you find here.</p><button onClick={() => createNote()}>Write your first note <span>→</span></button><div className="dn-hint">TIP · SELECT TEXT ON THE PAGE, THEN TAP ✳</div></div> : filteredNotes.length === 0 ? <div className="dn-empty">{query.trim() ? `No notes match “${query}”.` : 'No notes here yet.'}</div> : <div className="dn-content">
        <div className="dn-note-list">{filteredNotes.map(({ note, url }) => <div key={`${url}:${note.id}`} className={`dn-note-row-wrap ${selectedPageUrl === url && selectedId === note.id ? 'active' : ''}`}><button className="dn-note-row" onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}><span className="dn-note-dot"/><span className="dn-note-row-text"><strong>{note.pinned ? '📌 ' : ''}{note.title || 'Untitled note'}</strong><small>{showAllNotes || query ? new URL(url).hostname.replace(/^www\./, '') + ' · ' : ''}{note.body.trim().replace(/^>\s?/gm, '').slice(0, 58) || 'No content yet'}</small></span></button><button className={`dn-row-action ${note.favorite ? 'selected' : ''}`} title={note.favorite ? 'Remove favorite' : 'Add favorite'} aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleNoteFlag(note.id, 'favorite', url)}>{note.favorite ? '♥' : '♡'}</button><button className="dn-row-action" title={note.archived ? 'Restore from archive' : 'Archive note'} aria-label={note.archived ? 'Restore note' : 'Archive note'} onClick={() => toggleNoteFlag(note.id, 'archived', url)}>{note.archived ? '↶' : '▱'}</button></div>)}</div>
        {selected ? <article className="dn-editor"><div className="dn-editor-top"><span className="dn-note-type">NOTE</span><div className="dn-editor-actions"><button className={`dn-preview-toggle ${selected.pinned ? 'active' : ''}`} onClick={() => updateSelected({ pinned: !selected.pinned })}>{selected.pinned ? 'Unpin' : 'Pin'}</button><button className={`dn-preview-toggle ${selected.favorite ? 'active' : ''}`} onClick={() => updateSelected({ favorite: !selected.favorite })}>{selected.favorite ? '♥ Favorite' : '♡ Favorite'}</button><button className="dn-preview-toggle" onClick={() => setShowHistory((value) => !value)}>History</button><button className={`dn-preview-toggle ${preview ? 'active' : ''}`} onClick={() => setPreview((value) => !value)} aria-pressed={preview}>{preview ? 'Edit' : 'Preview'}</button><button className="dn-delete" onClick={deleteNote} title="Move note to trash">Delete</button></div></div><input className="dn-title" placeholder="Give this note a title…" value={selected.title} onChange={(event) => updateNote('title', event.target.value)} />{showHistory && <div className="dn-history-list">{(selected.history ?? []).length ? [...(selected.history ?? [])].reverse().map((revision) => <button key={revision.id} onClick={() => restoreRevision(revision)}><strong>{revision.title || 'Untitled note'}</strong><small>{new Date(revision.savedAt).toLocaleString()} · Restore</small></button>) : <small>No saved versions yet. Versions are captured during editing.</small>}</div>}{preview ? <div className="dn-markdown-preview" onClick={(event) => { const target = event.target as HTMLElement; const copy = target.closest<HTMLButtonElement>('[data-copy-code]'); if (copy) { const code = copy.parentElement?.querySelector('code')?.textContent ?? ''; void navigator.clipboard?.writeText(code).then(() => { copy.textContent = 'Copied' }) } const anchor = target.closest('a'); const href = anchor?.getAttribute('href'); if (href?.startsWith('#devnotes-note-')) { event.preventDefault(); openLinkedNote(decodeURIComponent(href.slice('#devnotes-note-'.length))) } }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse((selected.body || '*Nothing to preview yet.*').replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => `[${title}](#devnotes-note-${encodeURIComponent(title)})`)).replace(/<\/pre>/g, '<button type="button" data-copy-code>Copy</button></pre>')) }} /> : <textarea className="dn-body" placeholder="Start writing…" value={selected.body} onChange={(event) => updateNote('body', event.target.value)} />}<div className="dn-collection-assign">{collections.length ? collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={selected.collectionIds?.includes(collection.id) ?? false} onChange={(event) => { const ids = selected.collectionIds ?? []; updateSelected({ collectionIds: event.target.checked ? [...ids, collection.id] : ids.filter((id) => id !== collection.id) }) }} />{collection.name}</label>) : <button className="dn-collection-add" onClick={createCollection}>＋ Create a collection</button>}</div><TagInput key={selected.id} tags={selected.tags ?? []} onCommit={(tags) => updateNote('tags', tags)} />{backlinks.length > 0 && <div className="dn-backlinks"><strong>Linked from</strong>{backlinks.map(({ note, url }) => <button key={note.id} onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}>{note.title || 'Untitled note'}</button>)}</div>}<div className="dn-editor-footer"><span><i/>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed · try editing again' : 'Saved locally'}</span></div></article> : null}
      </div>}
    </aside>
  </>
}

export default App
