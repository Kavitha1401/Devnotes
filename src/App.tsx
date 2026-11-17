import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Note = { id: string; title: string; body: string; tags?: string[]; createdAt: number; updatedAt: number }
type PageNotes = Record<string, Note[]>

const STORAGE_KEY = 'devnotes-pages'
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

function readPages(): Promise<PageNotes> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(STORAGE_KEY, (result) => resolve((result[STORAGE_KEY] as PageNotes | undefined) ?? {}))
      return
    }
    try { resolve(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')) } catch { resolve({}) }
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPageUrl, setSelectedPageUrl] = useState(pageUrl)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const searchRef = useRef<HTMLInputElement>(null)
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
    return () => { active = false }
  }, [])

  useEffect(() => {
    const toggle = () => setOpen((value) => !value)
    window.addEventListener('devnotes-toggle', toggle)
    return () => window.removeEventListener('devnotes-toggle', toggle)
  }, [])

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

  const createNote = useCallback((body = '') => {
    const now = Date.now()
    const note: Note = { id: crypto.randomUUID(), title: '', body, tags: [], createdAt: now, updatedAt: now }
    persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
    setSelectedPageUrl(pageUrl)
    setSelectedId(note.id)
  }, [pages, persist])

  const updateNote = (field: 'title' | 'body' | 'tags', value: string | string[]) => {
    if (!selected) return
    const updated: Note = field === 'tags'
      ? { ...selected, tags: value as string[], updatedAt: Date.now() }
      : { ...selected, [field]: value as string, updatedAt: Date.now() }
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? updated : note) })
  }

  const deleteNote = () => {
    if (!selected) return
    const remaining = selectedNotes.filter((note) => note.id !== selected.id)
    persist({ ...pages, [selectedPageUrl]: remaining })
    setSelectedId(remaining[0]?.id ?? null)
  }

  const allNotes = useMemo(() => Object.entries(pages).flatMap(([url, items]) => items.map((note) => ({ note, url }))), [pages])
  const filteredNotes = useMemo(() => {
    if (!query.trim()) return notes.map((note) => ({ note, url: pageUrl }))
    const needle = query.toLowerCase()
    return allNotes.filter(({ note, url }) => `${note.title} ${note.body} ${(note.tags ?? []).join(' ')} ${url}`.toLowerCase().includes(needle))
  }, [allNotes, notes, query])

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
  const captureSelection = () => {
    const text = window.getSelection()?.toString().trim()
    if (text) createNote(`> ${text}\n\n`)
    else createNote()
  }

  return <>
    {!open && <button className="dn-launcher" onClick={() => setOpen(true)} aria-label="Open DevNotes" title="DevNotes"><span className="dn-mark">d<span>.</span></span></button>}
    <aside className={`dn-panel ${open ? 'is-open' : ''}`} aria-label="DevNotes panel" aria-hidden={!open}>
      <header className="dn-header">
        <div className="dn-brand"><span className="dn-brand-icon">d<span>.</span></span><span>devnotes</span></div>
        <button className="dn-icon-button" onClick={() => setOpen(false)} aria-label="Close panel">×</button>
      </header>
      <div className="dn-page"><div className="dn-site-icon">{hostname[0]?.toUpperCase()}</div><div className="dn-page-copy"><strong>{hostname}</strong><span title={pageTitle}>{pageTitle}</span></div><button className="dn-icon-button dn-more" title="Capture selected text" onClick={captureSelection}>✳</button></div>
      <div className="dn-page-heading"><h1>Page notes <span>{notes.length}</span></h1><div className="dn-heading-actions"><button className="dn-export" onClick={exportMarkdown} disabled={!allNotes.length} title="Export all notes as Markdown">Export</button><button className="dn-new" onClick={() => createNote()}><b>＋</b> New note</button></div></div>
      <label className="dn-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8"/><path d="m13.2 13.2 4 4"/></svg><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" /><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd></label>
      {!ready ? <div className="dn-empty">Loading your notes…</div> : notes.length === 0 && !query.trim() ? <div className="dn-empty-state"><div className="dn-empty-icon">✎</div><strong>A fresh page to think on.</strong><p>Keep the useful bits, questions, and ideas you find here.</p><button onClick={() => createNote()}>Write your first note <span>→</span></button><div className="dn-hint">TIP · SELECT TEXT ON THE PAGE, THEN TAP ✳</div></div> : filteredNotes.length === 0 ? <div className="dn-empty">No notes match “{query}”.</div> : <div className="dn-content">
        <div className="dn-note-list">{filteredNotes.map(({ note, url }) => <button key={`${url}:${note.id}`} className={`dn-note-row ${selectedPageUrl === url && selectedId === note.id ? 'active' : ''}`} onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}><span className="dn-note-dot"/><span className="dn-note-row-text"><strong>{note.title || 'Untitled note'}</strong><small>{query ? new URL(url).hostname.replace(/^www\./, '') + ' · ' : ''}{note.body.trim().replace(/^>\s?/gm, '').slice(0, 58) || 'No content yet'}</small></span></button>)}</div>
        {selected ? <article className="dn-editor"><div className="dn-editor-top"><span className="dn-note-type">NOTE</span><button className="dn-delete" onClick={deleteNote} title="Delete note">Delete</button></div><input className="dn-title" placeholder="Give this note a title…" value={selected.title} onChange={(event) => updateNote('title', event.target.value)} /><textarea className="dn-body" placeholder="Start writing…" value={selected.body} onChange={(event) => updateNote('body', event.target.value)} /><TagInput key={selected.id} tags={selected.tags ?? []} onCommit={(tags) => updateNote('tags', tags)} /><div className="dn-editor-footer"><span><i/>{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed · try editing again' : 'Saved locally'}</span></div></article> : null}
      </div>}
    </aside>
  </>
}

export default App
