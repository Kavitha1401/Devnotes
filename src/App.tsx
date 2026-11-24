import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { DEFAULT_BLOCKED_HOSTS, DEFAULT_SETTINGS, HIGHLIGHT_COLORS, SETTINGS_KEY, hostMatches, isHostDisabled, normalizeHost, normalizeSettings, readSettings, writeSettings, type DevNotesSettings } from './settings'
import { cleanNoteBody, isRecord, mergePages, migratePages, normalizePageUrl, removeDeletedPages } from './storage/core'
import { validateBackup } from './storage/backup'
import type { BackupFile, Collection, Highlight, Note, NotePlacement, PageMeta, PageNotes, PageTask, Revision, TrashEntry } from './storage/types'
import { findBestAnchor } from './highlights/anchor'
import { TagInput } from './components/TagInput'
import { AnnotationCard } from './components/AnnotationCard'
import { useSystemTheme } from './hooks/useSystemTheme'

const EMPTY_PAGE_META: PageMeta = { status: 'to-read', whySaved: '', tasks: [], journalEntry: '', journalEntries: {}, updatedAt: 0 }
type AnnotationPlacement = { item: Highlight; index: number; side: 'left' | 'right' | 'marker'; x: number; y: number; anchorX: number; anchorY: number; rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }; note?: Note }
type ReviewItem = { id: string; kind: 'note' | 'highlight'; url: string; title: string; text: string; note?: Note; createdAt: number }

const STORAGE_KEY = 'devnotes-pages'
const DELETED_KEY = 'devnotes-deleted-notes'
const HIGHLIGHT_KEY = 'devnotes-highlights'
const COLLECTION_KEY = 'devnotes-collections'
const TRASH_KEY = 'devnotes-trash'
const PAGEMETA_KEY = 'devnotes-pagemeta'
const SCHEMA_VERSION_KEY = 'devnotes-schema-version'
const CURRENT_SCHEMA_VERSION = 1
const isIncognitoContext = () => typeof chrome !== 'undefined' && Boolean(chrome.extension?.inIncognitoContext)
const NOTE_TEMPLATES = {
  'Bug report': '# Bug report\n\n## Summary\n\n## Steps to reproduce\n1. \n\n## Expected behavior\n\n## Actual behavior\n\n## Environment\n',
  'Meeting notes': '# Meeting notes\n\nDate: \nAttendees: \n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Action items\n- [ ] \n',
  'Reading note': '# Reading note\n\n## Summary\n\n## Key ideas\n- \n\n## Quotes\n> \n\n## My thoughts\n\n## Follow-up\n',
} as const
function pruneTombstones(value: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000
  return Object.fromEntries(Object.entries(value).filter(([, deletedAt]) => typeof deletedAt === 'number' && deletedAt >= cutoff).sort((a, b) => a[1] - b[1]).slice(-2_000))
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Unknown page' }
}

function readDeletedNotes(): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    if (isIncognitoContext()) { resolve({}); return }
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
    if (isIncognitoContext()) { resolve({}); return }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY, SCHEMA_VERSION_KEY], (result) => {
        const migrated = migratePages<Note>((result[STORAGE_KEY] as PageNotes | undefined) ?? {})
        if (Number(result[SCHEMA_VERSION_KEY] ?? 0) < CURRENT_SCHEMA_VERSION) {
          try { chrome.storage.local.set({ [STORAGE_KEY]: migrated, [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION }) } catch { /* The panel remains usable in memory if storage is unavailable. */ }
        }
        resolve(migrated)
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve({}); return }
    try {
      const migrated = migratePages<Note>(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
      if (Number(localStorage.getItem(SCHEMA_VERSION_KEY) ?? 0) < CURRENT_SCHEMA_VERSION) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
        localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION))
      }
      resolve(migrated)
    } catch { resolve({}) }
  })
}

function writePages(pages: PageNotes, deletedNotes: Record<string, number> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isIncognitoContext()) { resolve(); return }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY, DELETED_KEY], (result) => {
        const current = migratePages<Note>((result[STORAGE_KEY] as PageNotes | undefined) ?? {})
        let deleted = pruneTombstones({ ...((result[DELETED_KEY] as Record<string, number> | undefined) ?? {}), ...deletedNotes })
        for (const notes of Object.values(pages)) for (const note of notes) if (note.updatedAt > (deleted[note.id] ?? 0)) delete deleted[note.id]
        deleted = pruneTombstones(deleted)
        const merged = removeDeletedPages(mergePages(current, pages), deleted)
        chrome.storage.local.set({ [STORAGE_KEY]: merged, [DELETED_KEY]: deleted, [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION }, () => {
          const error = chrome.runtime.lastError
          if (error) reject(new Error(error.message))
          else resolve()
        })
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable. Reload DevNotes and refresh this page.')); return }
    try {
      const current = migratePages<Note>(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
      let deleted = pruneTombstones({ ...JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}'), ...deletedNotes })
      for (const notes of Object.values(pages)) for (const note of notes) if (note.updatedAt > (deleted[note.id] ?? 0)) delete deleted[note.id]
      deleted = pruneTombstones(deleted)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(removeDeletedPages(mergePages(current, pages), deleted)))
      localStorage.setItem(DELETED_KEY, JSON.stringify(deleted))
      localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION))
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

function readHighlights(): Promise<Record<string, Highlight[]>> {
  return new Promise((resolve) => {
    if (isIncognitoContext()) { resolve({}); return }
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
    if (isIncognitoContext()) { resolve(); return }
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
      if (/^https?:$/.test(new URL(key).protocol) && Array.isArray(items)) {
        normalized[key] = items
          .filter((item): item is Highlight => isRecord(item) && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.prefix === 'string' && typeof item.suffix === 'string' && typeof item.color === 'string' && item.text.length <= 5_000)
          .map((item) => {
            const placement: NotePlacement = item.placement && typeof item.placement.dx === 'number' && typeof item.placement.dy === 'number'
              ? { side: item.placement.side === 'left' ? 'left' : 'right', dx: Math.round(item.placement.dx), dy: Math.round(item.placement.dy), manual: Boolean(item.placement.manual) }
              : { side: 'right', dx: 24, dy: 0 }
            return {
              ...item,
              color: HIGHLIGHT_COLORS.includes(item.color as any) ? item.color : HIGHLIGHT_COLORS[0],
              shape: ['marker', 'underline', 'box', 'bracket'].includes(item.shape ?? '') ? item.shape : 'marker',
              display: item.display === 'sticky' ? 'sticky' : 'inline',
              placement,
              status: item.status === 'orphan' ? 'orphan' : 'attached',
              stickyX: undefined,
              stickyY: undefined,
            }
          })
      }
    } catch { /* Skip malformed legacy anchors. */ }
  }
  return normalized
}

function readPageMeta(): Promise<Record<string, PageMeta>> {
  return new Promise((resolve) => {
    if (isIncognitoContext()) { resolve({}); return }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(PAGEMETA_KEY, (result) => resolve(normalizePageMeta(result[PAGEMETA_KEY])))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve({}); return }
    try { resolve(normalizePageMeta(JSON.parse(localStorage.getItem(PAGEMETA_KEY) ?? '{}'))) } catch { resolve({}) }
  })
}

function normalizePageMeta(value: unknown): Record<string, PageMeta> {
  if (!isRecord(value)) return {}
  const result: Record<string, PageMeta> = {}
  for (const [rawUrl, rawMeta] of Object.entries(value)) {
    if (!isRecord(rawMeta)) continue
    try {
      const url = normalizePageUrl(rawUrl)
      if (!/^https?:$/.test(new URL(url).protocol)) continue
      const journalEntries = isRecord(rawMeta.journalEntries)
        ? Object.fromEntries(Object.entries(rawMeta.journalEntries).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {}
      result[url] = {
        status: rawMeta.status === 'reading' || rawMeta.status === 'done' ? rawMeta.status : 'to-read',
        whySaved: typeof rawMeta.whySaved === 'string' ? rawMeta.whySaved : '',
        tasks: Array.isArray(rawMeta.tasks) ? rawMeta.tasks.filter((task): task is PageTask => isRecord(task) && typeof task.id === 'string' && typeof task.text === 'string' && typeof task.done === 'boolean') : [],
        journalEntry: typeof rawMeta.journalEntry === 'string' ? rawMeta.journalEntry : '',
        journalEntries: journalEntries as Record<string, string>,
        updatedAt: typeof rawMeta.updatedAt === 'number' ? rawMeta.updatedAt : Date.now(),
      }
    } catch { /* Ignore malformed page metadata without blocking other pages. */ }
  }
  return result
}

function writePageMeta(meta: Record<string, PageMeta>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isIncognitoContext()) { resolve(); return }
    const normalized = normalizePageMeta(meta)
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        chrome.storage.local.set({ [PAGEMETA_KEY]: normalized }, () => {
          const error = chrome.runtime.lastError
          if (error) reject(new Error(error.message))
          else resolve()
        })
      } catch (error) { reject(error) }
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable.')); return }
    try { localStorage.setItem(PAGEMETA_KEY, JSON.stringify(normalized)); resolve() } catch (error) { reject(error) }
  })
}

function localDateKey(time = Date.now()) {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function readCollections(): Promise<Collection[]> {
  return new Promise((resolve) => {
    if (isIncognitoContext()) { resolve([]); return }
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
    if (isIncognitoContext()) { resolve(); return }
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
    if (isIncognitoContext()) { resolve([]); return }
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
    if (isIncognitoContext()) { resolve(); return }
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

function pageTextNodes(searchRoot?: Node): Text[] {
  const nodes: Text[] = []
  const visit = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement
          if (!node.textContent || parent?.closest('script, style, noscript, textarea, input, select, [contenteditable]:not([contenteditable="false"]), #devnotes-root')) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        }
        if (node instanceof HTMLElement && node.matches('script, style, noscript, textarea, input, select, [contenteditable]:not([contenteditable="false"]), #devnotes-root')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const shadowRoots: ShadowRoot[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text)
      else if (node instanceof HTMLElement && node.shadowRoot) shadowRoots.push(node.shadowRoot)
    }
    for (const shadowRoot of shadowRoots) visit(shadowRoot)
  }
  const base = searchRoot ?? document.body
  if (base?.nodeType === Node.TEXT_NODE) nodes.push(base as Text)
  else if (base) visit(base)
  return nodes
}

function findContentColumn() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('article, main, [role="main"], [itemprop="articleBody"], .markdown-body, #content, .content, .article, .post-content'))
    .filter((element) => !element.closest('#devnotes-root') && (element.innerText?.length ?? 0) > 200)
    .sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))
  const fallback = Array.from(document.body?.children ?? [])
    .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.matches('nav, header, footer, aside, #devnotes-root') && (element.innerText?.length ?? 0) > 200)
    .sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))[0]
  const candidate = candidates[0] ?? fallback
  if (!candidate) return null
  const rect = candidate.getBoundingClientRect()
  return { left: rect.left, right: rect.right }
}

function compareDomPoints(leftNode: Node, leftOffset: number, rightNode: Node, rightOffset: number): number {
  const left = document.createRange()
  left.setStart(leftNode, leftOffset)
  left.collapse(true)
  const right = document.createRange()
  right.setStart(rightNode, rightOffset)
  right.collapse(true)
  return left.compareBoundaryPoints(Range.START_TO_START, right)
}

function pageTextOffset(nodes: Text[], container: Node, offset: number): number {
  let total = 0
  for (const node of nodes) {
    const length = node.textContent?.length ?? 0
    const endOrder = compareDomPoints(node, length, container, offset)
    if (endOrder <= 0) { total += length; continue }
    if (node === container) total += Math.max(0, Math.min(length, offset))
    break
  }
  return total
}

function isDarkPageSurface(node: Element | null) {
  let current: Element | null = node
  while (current) {
    const background = getComputedStyle(current).backgroundColor
    const match = background.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/)
    if (match && Number(match[4] ?? 1) > 0.08) {
      const channel = (value: string) => {
        const normalized = Number(value) / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      const luminance = 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3])
      return luminance < 0.28
    }
    current = current.parentElement
  }
  return false
}

function highlightStyle(shape: Highlight['shape'], color: string, darkSurface = false) {
  if (shape === 'none' || color === 'transparent') return 'background:transparent; color:inherit;'
  if (shape === 'underline') return `background:transparent; color:inherit; text-decoration:underline wavy ${darkSurface ? `color-mix(in srgb, ${color} 55%, white)` : color}; text-decoration-thickness:2px; text-underline-offset:3px;`
  if (shape === 'box') return `background:transparent; color:inherit; outline:1px solid ${color}; outline-offset:1px; border-radius:3px;`
  if (shape === 'bracket') return `background:transparent; color:inherit; border-left:2px solid ${color}; border-right:2px solid ${color}; padding:0 2px;`
  return darkSurface
    ? `background:color-mix(in srgb, ${color} 24%, transparent); color:#fff; border-radius:2px; padding:0 1px;`
    : `background:${color}; color:#182018; border-radius:2px; padding:0 1px;`
}

function wrapTextOffsets(nodes: Text[], start: number, end: number, id: string, color: string, shape: Highlight['shape'] = 'marker') {
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
      mark.style.cssText = highlightStyle(shape, color, isDarkPageSurface(node.parentElement))
      try { range.surroundContents(mark) } catch { /* Leave text visible if a site mutates the selected node mid-restore. */ }
    }
    offset += text.length
    if (offset >= end) break
  }
}

// eslint-disable-next-line react/only-export-components
export function applyHighlights(highlights: Highlight[], clearExisting = true): string[] {
  if (!document.body) return []
  if (clearExisting) clearPageHighlights()
  const orphaned: string[] = []
  for (const item of highlights) {
    if (!item.text) continue
    const nodes = pageTextNodes()
    const text = nodes.map((node) => node.textContent ?? '').join('')
    const index = findBestAnchor(text, item)
    if (index >= 0) wrapTextOffsets(nodes, index, index + item.text.length, item.id, item.color, item.shape)
    else orphaned.push(item.id)
  }
  return orphaned
}

function highlightElements(id?: string): HTMLElement[] {
  const elements: HTMLElement[] = []
  const visit = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>('[data-devnotes-highlight]').forEach((mark) => {
      if (!id || mark.dataset.devnotesHighlight === id) elements.push(mark)
    })
    root.querySelectorAll<HTMLElement>('*').forEach((element) => { if (element.shadowRoot) visit(element.shadowRoot) })
  }
  visit(document)
  return elements
}

function clearPageHighlights() {
  highlightElements().forEach((mark) => mark.replaceWith(...Array.from(mark.childNodes)))
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

function getRangeFromPoint(x: number, y: number): Range | null {
  if (typeof document.caretRangeFromPoint === 'function') {
    return document.caretRangeFromPoint(x, y)
  }
  const doc = document as any
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos && pos.offsetNode) {
      const range = document.createRange()
      range.setStart(pos.offsetNode, pos.offset)
      range.collapse(true)
      return range
    }
  }
  return null
}

function findNearestTextAnchor(clientX: number, clientY: number): { text: string; prefix: string; suffix: string; start: number; end: number } | null {
  const range = getRangeFromPoint(clientX, clientY)
  if (!range) return null
  const nodes = pageTextNodes()
  const pageText = nodes.map((node) => node.textContent ?? '').join('')
  const offset = pageTextOffset(nodes, range.startContainer, range.startOffset)
  if (offset < 0 || offset > pageText.length) return null

  let start = Math.max(0, offset - 12)
  let end = Math.min(pageText.length, offset + 28)
  while (start > 0 && !/\s/.test(pageText[start - 1])) start--
  while (end < pageText.length && !/\s/.test(pageText[end])) end++
  const text = pageText.slice(start, end).trim()
  if (!text) return null
  start += pageText.slice(start, end).length - pageText.slice(start, end).trimStart().length
  end = start + text.length
  const prefix = pageText.slice(Math.max(0, start - 80), start)
  const suffix = pageText.slice(end, Math.min(pageText.length, end + 80))
  return { text, prefix, suffix, start, end }
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
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [personalizeOpen, setPersonalizeOpen] = useState(false)
  const [settings, setSettings] = useState<DevNotesSettings>(DEFAULT_SETTINGS)
  const [settingsReady, setSettingsReady] = useState(false)
  const systemDark = useSystemTheme()
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
  const [allPageMeta, setAllPageMeta] = useState<Record<string, PageMeta>>({})
  const [pageMetaReady, setPageMetaReady] = useState(false)
  const [pageTaskDraft, setPageTaskDraft] = useState('')
  const [storedHighlightsByUrl, setStoredHighlightsByUrl] = useState<Record<string, Highlight[]>>({})
  const [showDailyReview, setShowDailyReview] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewScope, setReviewScope] = useState<'site' | 'tag'>('site')
  const [reviewTag, setReviewTag] = useState('')
  const [reviewIndex, setReviewIndex] = useState(0)
  const [onboardingStep, setOnboardingStep] = useState<number | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; highlightIds?: string[] } | null>(null)
  const [runtimeInvalid, setRuntimeInvalid] = useState(false)
  const [incognitoMode] = useState(() => isIncognitoContext())
  const [toolbarAltHeld, setToolbarAltHeld] = useState(false)
  const captureSelectionRef = useRef<(action?: 'highlight' | 'note' | 'sticky', color?: string) => boolean>(() => false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [annotationLayoutTick, setAnnotationLayoutTick] = useState(0)
  const [orphanedHighlights, setOrphanedHighlights] = useState<string[]>([])
  const [annotationUndo, setAnnotationUndo] = useState<{ item: Highlight; note?: Note; url: string } | null>(null)
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
  const [bulkTagEditing, setBulkTagEditing] = useState(false)
  const [bulkTagDraft, setBulkTagDraft] = useState('')
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
  const pageMetaDirtyRef = useRef(false)
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)
  const notes = useMemo(() => pages[pageUrl] ?? [], [pages, pageUrl])
  const selectedNotes = useMemo(() => pages[selectedPageUrl] ?? [], [pages, selectedPageUrl])
  const selected = selectedNotes.find((note) => note.id === selectedId) ?? null
  const hostname = location.hostname.replace(/^www\./, '') || 'This page'
  const darkTheme = settings.theme === 'dark' || (settings.theme === 'system' && systemDark)
  const effectiveTheme = settings.theme === 'system' ? (darkTheme ? 'dark' : 'light') : settings.theme
  const todayKey = localDateKey()
  const pageMeta = allPageMeta[pageUrl] ?? EMPTY_PAGE_META
  const todayJournal = pageMeta.journalEntries?.[todayKey] ?? pageMeta.journalEntry
  const allHighlightsByUrl = useMemo(() => highlightsForUrl === pageUrl ? { ...storedHighlightsByUrl, [pageUrl]: highlights } : storedHighlightsByUrl, [storedHighlightsByUrl, highlightsForUrl, pageUrl, highlights])

  useEffect(() => { highlightsRef.current = highlights }, [highlights])

  useEffect(() => {
    if (!pageMetaReady || !pageMetaDirtyRef.current) return
    const timer = window.setTimeout(() => {
      void writePageMeta(allPageMeta).then(() => { pageMetaDirtyRef.current = false }, () => { setSaveState('error'); setRuntimeInvalid(true) })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [allPageMeta, pageMetaReady])

  useEffect(() => {
    const stopSiteHotkeys = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .CodeMirror, .monaco-editor, .cm-editor')) event.stopPropagation()
    }
    for (const type of ['keydown', 'keyup', 'keypress']) messageTarget.addEventListener(type, stopSiteHotkeys, true)
    return () => { for (const type of ['keydown', 'keyup', 'keypress']) messageTarget.removeEventListener(type, stopSiteHotkeys, true) }
  }, [messageTarget])

  useEffect(() => {
    if (typeof chrome === 'undefined') return
    const checkContext = () => setRuntimeInvalid(!chrome.runtime?.id)
    checkContext()
    const timer = window.setInterval(checkContext, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([readPages(), readDeletedNotes()]).then(([saved, deleted]) => {
      if (!active) return
      setDeletedNotes(deleted)
      const visiblePages = removeDeletedPages(saved, deleted)
      setPages(visiblePages)
      setSelectedId(visiblePages[initialPageUrlRef.current]?.[0]?.id ?? null)
      setReady(true)
    }).catch(() => {
      if (!active) return
      setRuntimeInvalid(true)
      setReady(true)
      setImportError('DevNotes could not read local storage. Your edits will stay in memory until you copy them.')
    })
    void readCollections().then((saved) => { if (active) { setCollections(saved); setCollectionsReady(true) } })
    void readSettings().then((saved) => {
      if (!active) return
      setSettings(saved)
      setSettingsReady(true)
      if (!saved.onboardingComplete) {
        void Promise.all([readPages(), readHighlights()]).then(([savedPages, savedHighlights]) => {
          if (!active || Object.keys(savedPages).length > 0 || Object.values(savedHighlights).some((items) => items.length > 0)) return
          setOpen(true)
          setOnboardingStep(0)
        }).catch(() => {})
      }
      void readTrash().then((items) => {
        if (!active) return
        const retained = boundedTrash(items, saved.trashRetentionDays)
        setTrash(retained)
        if (retained.length !== items.length) void writeTrash(retained, saved.trashRetentionDays)
      })
    })
    void readPageMeta().then((meta) => { if (active) { setAllPageMeta(meta); setPageMetaReady(true) } }, () => { if (active) { setRuntimeInvalid(true); setPageMetaReady(true) } })
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
      }, () => { setSaveState('error'); setRuntimeInvalid(true) })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [settings, settingsReady])

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
    let isApplying = false

    const runApplyHighlights = (items: Highlight[]) => {
      if (isApplying || !active) return
      isApplying = true
      observer?.disconnect()
      clearPageHighlights()
      const orphaned: string[] = []
      let offset = 0
      const idleWindow = window as Window & { requestIdleCallback?: (callback: (deadline: { timeRemaining: () => number }) => void, options?: { timeout: number }) => number }
      const processChunk = () => {
        if (!active) return
        const chunk = items.slice(offset, offset + 12)
        offset += chunk.length
        orphaned.push(...applyHighlights(chunk, false))
        if (offset < items.length) {
          if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(processChunk, { timeout: 120 })
          else window.setTimeout(processChunk, 16)
          return
        }
        setOrphanedHighlights(orphaned)
        isApplying = false
        if (active && document.body && observer) {
          observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          document.querySelectorAll<HTMLElement>('*').forEach((element) => {
            if (element.shadowRoot) observer?.observe(element.shadowRoot, { childList: true, subtree: true, characterData: true })
          })
        }
      }
      processChunk()
    }

    clearPageHighlights()
    void readHighlights().then((saved) => {
      if (!active) return
      setStoredHighlightsByUrl(saved)
      const pageHighlights = saved[pageUrl] ?? []
      setHighlights(pageHighlights)
      runApplyHighlights(pageHighlights)
      setHighlightsForUrl(pageUrl)
      observer = new MutationObserver((mutations) => {
        if (isApplying) return
        const isDevNotesNode = (node: Node) => {
          const element = node instanceof HTMLElement ? node : node.parentElement
          return Boolean(element && (element.hasAttribute('data-devnotes-highlight') || element.closest('#devnotes-root')))
        }
        const changedRoots = mutations.flatMap((mutation) => [
          ...Array.from(mutation.addedNodes).filter((node) => !isDevNotesNode(node)),
          ...(mutation.type === 'characterData' && !isDevNotesNode(mutation.target) ? [mutation.target.parentNode ?? mutation.target] : []),
        ])
        const present = new Set(highlightElements().map((mark) => mark.dataset.devnotesHighlight))
        const missing = highlightsRef.current.filter((item) => item.text && !present.has(item.id))
        if (!missing.length) return

        window.clearTimeout(restoreTimer)
        restoreTimer = window.setTimeout(() => {
          if (!changedRoots.length) {
            setOrphanedHighlights((current) => [...new Set([...current, ...missing.map((item) => item.id)])])
            return
          }
          const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }
          const processChangedSubtrees = () => {
            const addedTextNodes = changedRoots.flatMap((root) => root.isConnected ? pageTextNodes(root) : [])
            const changedText = addedTextNodes.map((node) => node.textContent ?? '').join('')
            let offset = 0
            const processChunk = () => {
              const chunk = missing.slice(offset, offset + 12)
              offset += chunk.length
              const reanchored: string[] = []
              const orphaned: string[] = []
              for (const item of chunk) {
                const index = findBestAnchor(changedText, item)
                if (index < 0) { orphaned.push(item.id); continue }
                wrapTextOffsets(addedTextNodes, index, index + item.text.length, item.id, item.color, item.shape)
                reanchored.push(item.id)
              }
              setOrphanedHighlights((current) => [...new Set([...current.filter((id) => !reanchored.includes(id)), ...orphaned])])
              if (offset < missing.length) {
                if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(processChunk, { timeout: 200 })
                else window.setTimeout(processChunk, 16)
                return
              }
              document.querySelectorAll<HTMLElement>('*').forEach((element) => {
                if (element.shadowRoot) observer?.observe(element.shadowRoot, { childList: true, subtree: true, characterData: true })
              })
            }
            processChunk()
          }
          if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(processChangedSubtrees, { timeout: 200 })
          else window.setTimeout(processChangedSubtrees, 16)
        }, 120)
      })
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        document.querySelectorAll<HTMLElement>('*').forEach((element) => {
          if (element.shadowRoot) observer?.observe(element.shadowRoot, { childList: true, subtree: true, characterData: true })
        })
      }
    })
    return () => { active = false; observer?.disconnect(); window.clearTimeout(restoreTimer) }
  }, [pageUrl])

  useEffect(() => {
    if (!collectionsReady || !collectionsDirtyRef.current) return
    collectionsDirtyRef.current = false
    const timer = window.setTimeout(() => { void writeCollections(collections).catch(() => { setSaveState('error'); setRuntimeInvalid(true) }) }, 350)
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
      }).catch(() => { setSaveState('error'); setRuntimeInvalid(true) })
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
      const target = event.target as HTMLElement | null
      if (target?.id === 'devnotes-root' || target?.closest('#devnotes-root')) {
        return
      }
      const mark = event.composedPath().find((entry): entry is HTMLElement => entry instanceof HTMLElement && entry.hasAttribute('data-devnotes-highlight'))
      if (!mark) return
      const id = mark.dataset.devnotesHighlight
      if (!id) return
      event.preventDefault()
      event.stopPropagation()
      const rect = mark.getBoundingClientRect()
      setSelectionToolbar({
        x: Math.max(8, Math.min(window.innerWidth - 260, rect.left + rect.width / 2 - 120)),
        y: Math.max(8, rect.top - 54),
        highlightIds: [id],
      })
    }
    document.addEventListener('click', onHighlightClick, true)
    return () => document.removeEventListener('click', onHighlightClick, true)
  }, [highlights])

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
        () => { if (version === pagesVersionRef.current) { setSaveState('error'); setRuntimeInvalid(true) } },
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
        highlightElements().forEach((mark) => {
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
  const dailyReviewItems = useMemo<ReviewItem[]>(() => {
    const notesToday = allNotes.filter(({ note }) => localDateKey(note.createdAt) === todayKey || localDateKey(note.updatedAt) === todayKey).map(({ note, url }) => ({ id: note.id, kind: 'note' as const, url, title: note.title || 'Untitled note', text: cleanNoteBody(note.body), note, createdAt: note.updatedAt }))
    const highlightsToday = Object.entries(allHighlightsByUrl).flatMap(([url, items]) => items.filter((item) => localDateKey(item.createdAt) === todayKey).map((item) => {
      const note = allNotes.find(({ note: candidate }) => candidate.id === item.noteId)?.note
      return { id: item.id, kind: 'highlight' as const, url, title: note?.title || 'Highlight', text: note ? cleanNoteBody(note.body) : `> ${item.text}`, note, createdAt: item.createdAt }
    }))
    return [...notesToday, ...highlightsToday].sort((a, b) => b.createdAt - a.createdAt)
  }, [allNotes, allHighlightsByUrl, todayKey])
  const reviewItems = useMemo<ReviewItem[]>(() => {
    const noteItems = allNotes.filter(({ url, note }) => reviewScope === 'site' ? safeHostname(url) === hostname : Boolean(reviewTag) && (note.tags ?? []).includes(reviewTag)).map(({ note, url }) => ({ id: note.id, kind: 'note' as const, url, title: note.title || 'Untitled note', text: cleanNoteBody(note.body), note, createdAt: note.updatedAt }))
    const highlightItems = Object.entries(allHighlightsByUrl).flatMap(([url, items]) => items.filter((item) => {
      if (reviewScope === 'site') return safeHostname(url) === hostname
      const note = allNotes.find(({ note: candidate }) => candidate.id === item.noteId)?.note
      return Boolean(reviewTag) && Boolean(note?.tags?.includes(reviewTag))
    }).map((item) => {
      const note = allNotes.find(({ note: candidate }) => candidate.id === item.noteId)?.note
      return { id: item.id, kind: 'highlight' as const, url, title: note?.title || 'Highlight', text: note ? cleanNoteBody(note.body) : `> ${item.text}`, note, createdAt: item.createdAt }
    }))
    return [...noteItems, ...highlightItems].sort((a, b) => a.createdAt - b.createdAt)
  }, [allNotes, allHighlightsByUrl, reviewScope, reviewTag, hostname])
  const backlinks = useMemo(() => selected ? allNotes.filter(({ note }) => note.id !== selected.id && (note.body.toLowerCase().includes(`[[${selected.title.trim().toLowerCase()}]]`) || note.body.includes(`[[id:${selected.id}|`))) : [], [allNotes, selected])
  const annotationNoteIds = useMemo(() => new Set(highlights.flatMap((item) => item.noteId ? [item.noteId] : [])), [highlights])

  const filteredNotes = useMemo(() => {
    const source = showAllNotes || deferredQuery.trim() || showTasks ? allNotes : notes.filter((note) => !annotationNoteIds.has(note.id)).map((note) => ({ note, url: pageUrl }))
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
  }, [allNotes, annotationNoteIds, notes, pageUrl, deferredQuery, showAllNotes, collectionFilter, showArchived, showFavorites, showTasks, domainFilter, sortMode, dateFrom, dateTo])

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

  useEffect(() => {
    let frame = 0
    const scheduleLayout = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setAnnotationLayoutTick((tick) => tick + 1))
    }
    const updateSelection = (altKey = false) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) {
        setSelectionToolbar(null)
        return
      }
      const range = selection.getRangeAt(0)
      const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      if (ancestor?.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], pre, code, .CodeMirror, .monaco-editor, .cm-editor')) {
        setSelectionToolbar(null)
        return
      }
      if (settings.toolbarBehavior === 'never' || (settings.toolbarBehavior === 'hold-alt' && !altKey)) {
        setSelectionToolbar(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return

      const ids = new Set<string>()
      const startMark = range.startContainer.parentElement?.closest<HTMLElement>('[data-devnotes-highlight]')
      if (startMark?.dataset.devnotesHighlight) ids.add(startMark.dataset.devnotesHighlight)
      const endMark = range.endContainer.parentElement?.closest<HTMLElement>('[data-devnotes-highlight]')
      if (endMark?.dataset.devnotesHighlight) ids.add(endMark.dataset.devnotesHighlight)

      highlightElements().forEach((m) => {
        try {
          if (range.intersectsNode(m) && m.dataset.devnotesHighlight) {
            ids.add(m.dataset.devnotesHighlight)
          }
        } catch {
          // ignore
        }
      })

      setSelectionToolbar({
        x: Math.max(8, Math.min(window.innerWidth - 260, rect.left + rect.width / 2 - 120)),
        y: Math.max(8, rect.top - 54),
        highlightIds: ids.size ? Array.from(ids) : undefined,
      })
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const path = event.composedPath()
      if (
        path.some((entry) => entry instanceof HTMLElement && entry.id === 'devnotes-root') ||
        target?.id === 'devnotes-root' ||
        target?.closest('#devnotes-root') ||
        path.some((entry) => entry instanceof HTMLElement && entry.hasAttribute('data-devnotes-highlight')) ||
        target?.closest('.dn-selection-toolbar')
      ) {
        return
      }
      setSelectionToolbar(null)
    }

    const onMouseUp = (event: MouseEvent) => updateSelection(event.altKey)
    const onKeyUp = (event: KeyboardEvent) => updateSelection(event.altKey)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) setToolbarAltHeld(true)
      if (event.key === 'Escape') setSelectionToolbar(null)
      const typing = event.composedPath().some((entry) => entry instanceof HTMLElement && entry.matches('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .CodeMirror, .monaco-editor, .cm-editor'))
      if (!typing && event.altKey && event.shiftKey && (event.key.toLowerCase() === 'h' || event.key.toLowerCase() === 'm')) {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && selection.toString().trim()) {
          event.preventDefault()
          captureSelectionRef.current(event.key.toLowerCase() === 'h' ? 'highlight' : 'note')
          selection.removeAllRanges()
          setSelectionToolbar(null)
        }
      }
    }
    const onKeyRelease = (event: KeyboardEvent) => { if (event.key === 'Alt') setToolbarAltHeld(false); onKeyUp(event) }
    const onScroll = () => {
      scheduleLayout()
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) updateSelection(toolbarAltHeld)
      else setSelectionToolbar(null)
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyRelease)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyRelease)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [settings.toolbarBehavior, toolbarAltHeld])

  useEffect(() => {
    let frame = 0
    const scheduleRelayout = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setAnnotationLayoutTick((tick) => tick + 1))
    }
    window.addEventListener('resize', scheduleRelayout)
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      resizeObserver = new ResizeObserver(scheduleRelayout)
      resizeObserver.observe(document.body)
    }
    if (document.fonts?.ready) {
      void document.fonts.ready.then(scheduleRelayout)
    }
    const onImgLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) scheduleRelayout()
    }
    window.addEventListener('load', scheduleRelayout)
    document.addEventListener('load', onImgLoad, true)
    const onInnerScroll = (event: Event) => {
      const target = event.target
      if (target && target !== document && target !== document.documentElement && target !== document.body) {
        scheduleRelayout()
      }
    }
    document.addEventListener('scroll', onInnerScroll, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleRelayout)
      window.removeEventListener('load', scheduleRelayout)
      document.removeEventListener('load', onImgLoad, true)
      document.removeEventListener('scroll', onInnerScroll, true)
      resizeObserver?.disconnect()
    }
  }, [])

  useEffect(() => {
    let style = document.getElementById('devnotes-annotation-page-style') as HTMLStyleElement | null
    const owned = !style
    if (!style) { style = document.createElement('style'); style.id = 'devnotes-annotation-page-style'; document.documentElement.appendChild(style) }
    style.textContent = `mark[data-devnotes-highlight]{cursor:pointer; transition:filter .12s;} mark[data-devnotes-highlight]:hover{filter:brightness(0.92);}`
    return () => { clearPageHighlights(); if (owned) style?.remove() }
  }, [])

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
    const additions = bulkTagDraft.split(',').map((tag) => tag.trim()).filter(Boolean)
    if (!additions.length) return
    bulkUpdate((note) => ({ ...note, tags: [...new Map([...(note.tags ?? []), ...additions].map((tag) => [tag.toLowerCase(), tag])).values()] }))
    setBulkTagDraft('')
    setBulkTagEditing(false)
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

  const updatePageMeta = (patch: Partial<PageMeta>) => {
    pageMetaDirtyRef.current = true
    setAllPageMeta((current) => {
      const previous = current[pageUrl] ?? { status: 'to-read', whySaved: '', tasks: [], journalEntry: '', journalEntries: {}, updatedAt: Date.now() }
      return { ...current, [pageUrl]: { ...previous, ...patch, updatedAt: Date.now() } }
    })
  }

  const addPageTask = () => {
    const text = pageTaskDraft.trim()
    if (!text) return
    updatePageMeta({ tasks: [...pageMeta.tasks, { id: crypto.randomUUID(), text, done: false }] })
    setPageTaskDraft('')
  }

  const updateTodayJournal = (entry: string) => updatePageMeta({ journalEntries: { ...(pageMeta.journalEntries ?? {}), [todayKey]: entry }, journalEntry: entry })

  const completeOnboarding = () => {
    updateSettings({ onboardingComplete: true })
    setOnboardingStep(null)
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
    const wildcard = host.trim().startsWith('*.')
    const base = normalizeHost(wildcard ? host.trim().slice(2) : host)
    try { if (new URL(`https://${base}`).hostname !== base) return } catch { return }
    const normalized = `${wildcard ? '*.' : ''}${base}`
    updateSettings({ disabledHosts: [...settings.disabledHosts, normalized], enabledHosts: settings.enabledHosts.filter((item) => item !== normalized) })
  }

  const allowHost = (host: string) => {
    const normalized = `${host.trim().startsWith('*.') ? '*.' : ''}${normalizeHost(host.trim().replace(/^\*\./, ''))}`
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
    highlightElements(id).forEach((mark) => { mark.style.cssText = highlightStyle(highlights.find((item) => item.id === id)?.shape, color, isDarkPageSurface(mark.parentElement)) })
    setHighlights((items) => items.map((item) => item.id === id ? { ...item, color } : item))
  }

  const moveNote = (id: string, droppedPageX: number, droppedPageY: number) => {
    highlightsDirtyRef.current = true
    const mark = highlightElements(id)[0]
    const scrollX = window.pageXOffset ?? window.scrollX ?? 0
    const scrollY = window.pageYOffset ?? window.scrollY ?? 0
    let dx = 24
    let dy = 0
    let side: 'left' | 'right' = 'right'

    if (mark) {
      const r = mark.getBoundingClientRect()
      const anchorLeft = r.left + scrollX
      const anchorTop = r.top + scrollY
      dx = Math.round(droppedPageX - anchorLeft)
      dy = Math.round(droppedPageY - anchorTop)
      side = dx >= 0 ? 'right' : 'left'
    }

    setHighlights((items) => items.map((item) => {
      if (item.id !== id) return item
      return {
        ...item,
        placement: { side, dx, dy, manual: true },
        stickyX: undefined,
        stickyY: undefined,
      }
    }))
  }

  const setEditing = (id: string, on: boolean) => setEditingId((current) => on ? id : current === id ? null : current)

  const cycleHighlightColor = (item: Highlight) => {
    const colors = HIGHLIGHT_COLORS as readonly string[]
    changeHighlightColor(item.id, colors[(colors.indexOf(item.color) + 1) % colors.length])
  }

  const openAnnotationNote = (item: Highlight) => {
    if (!item.noteId) return
    setOpen(true)
    setSelectedPageUrl(allNotes.find(({ note }) => note.id === item.noteId)?.url ?? pageUrl)
    setSelectedId(item.noteId)
  }

  // The note is created lazily, on the first character typed, so an untouched card never leaves an empty note behind.
  const setAnnotationText = (item: Highlight, text: string) => {
    if (item.noteId) {
      const noteUrl = allNotes.find(({ note }) => note.id === item.noteId)?.url ?? pageUrl
      persist({ ...pages, [noteUrl]: (pages[noteUrl] ?? []).map((note) => note.id === item.noteId ? { ...note, body: text, updatedAt: Date.now() } : note) })
      return
    }
    if (!text.trim()) return
    const now = Date.now()
    const note: Note = { id: crypto.randomUUID(), title: '', body: text, tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
    persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
    highlightsDirtyRef.current = true
    setHighlights((items) => items.map((entry) => entry.id === item.id ? { ...entry, noteId: note.id } : entry))
  }

  const toggleInlineTask = (noteId: string, taskIndex: number, done: boolean) => {
    const note = selectedNotes.find((n) => n.id === noteId) || allNotes.find(({ note: n }) => n.id === noteId)?.note
    if (!note) return
    let index = 0
    const updatedBody = note.body.replace(/^(\s*[-*+]\s+\[)( |x|X)(\])/gm, (line, prefix: string, _state: string, suffix: string) => {
      const current = index++
      return current === taskIndex ? `${prefix}${done ? 'x' : ' '}${suffix}` : line
    })
    const noteUrl = selectedNotes.some((n) => n.id === noteId) ? selectedPageUrl : (allNotes.find(({ note: n }) => n.id === noteId)?.url ?? pageUrl)
    persist({
      ...pages,
      [noteUrl]: (pages[noteUrl] ?? []).map((n) => n.id === noteId ? { ...n, body: updatedBody, updatedAt: Date.now() } : n),
    })
  }

  const reattachHighlight = (highlightId: string) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) {
      setImportError('Select the replacement passage on the page, then choose Reattach again.')
      return
    }
    const range = selection.getRangeAt(0)
    const nodes = pageTextNodes()
    const pageText = nodes.map((node) => node.textContent ?? '').join('')
    let start = pageTextOffset(nodes, range.startContainer, range.startOffset)
    let end = pageTextOffset(nodes, range.endContainer, range.endOffset)
    const selectedText = pageText.slice(start, end)
    const text = selectedText.trim()
    if (!text) return
    start += selectedText.length - selectedText.trimStart().length
    end = start + text.length
    const prefix = pageText.slice(Math.max(0, start - 80), start)
    const suffix = pageText.slice(end, Math.min(pageText.length, end + 80))

    const updated = highlights.map((item) => {
      if (item.id !== highlightId) return item
      return {
        ...item,
        text,
        prefix,
        suffix,
        status: 'attached' as const,
        placement: { side: 'right' as const, dx: 24, dy: 0 },
      }
    })

    clearPageHighlights()
    const found = updated.find((h) => h.id === highlightId)
    wrapTextOffsets(nodes, start, end, highlightId, found?.color ?? '#f6e58d', found?.shape)
    highlightsDirtyRef.current = true
    setHighlights(updated)
    setOrphanedHighlights((prev) => prev.filter((id) => id !== highlightId))
    setAnnotationLayoutTick((t) => t + 1)
  }

  const deleteAnnotationCard = (id: string) => {
    highlightsDirtyRef.current = true
    highlightElements(id).forEach((mark) => {
      const parent = mark.parentNode
      if (!parent) return
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      mark.remove()
      parent.normalize()
    })
    const target = highlights.find((item) => item.id === id)
    let deletedNote: Note | undefined
    let deletedUrl = pageUrl
    if (target?.noteId) {
      const noteUrl = allNotes.find(({ note }) => note.id === target.noteId)?.url ?? pageUrl
      const noteObj = (pages[noteUrl] ?? []).find((note) => note.id === target.noteId)
      deletedNote = noteObj
      deletedUrl = noteUrl
      if (noteObj) {
        const nextTrash = boundedTrash([...trash, { note: noteObj, url: noteUrl, deletedAt: Date.now() }], settings.trashRetentionDays)
        setTrash(nextTrash)
        void writeTrash(nextTrash, settings.trashRetentionDays)
      }
      persist({
        ...pages,
        [noteUrl]: (pages[noteUrl] ?? []).filter((note) => note.id !== target.noteId),
      })
    }
    if (target) setAnnotationUndo({ item: target, note: deletedNote, url: deletedUrl })
    setHighlights((items) => items.filter((item) => item.id !== id))
    setEditingId((current) => current === id ? null : current)
    setAnnotationLayoutTick((t) => t + 1)
  }

  const undoAnnotationDelete = () => {
    if (!annotationUndo) return
    const nextHighlights = [...highlights.filter((item) => item.id !== annotationUndo.item.id), annotationUndo.item]
    highlightsDirtyRef.current = true
    setHighlights(nextHighlights)
    setOrphanedHighlights(applyHighlights(nextHighlights))
    if (annotationUndo.note) {
      const restoredNote = { ...annotationUndo.note, updatedAt: Date.now() }
      persist({ ...pages, [annotationUndo.url]: [restoredNote, ...(pages[annotationUndo.url] ?? []).filter((note) => note.id !== restoredNote.id)] })
      const nextTrash = trash.filter((entry) => entry.note.id !== annotationUndo.note?.id)
      setTrash(nextTrash)
      void writeTrash(nextTrash, settings.trashRetentionDays)
    }
    setAnnotationUndo(null)
  }

  const removeHighlight = (id: string) => {
    const target = highlights.find((item) => item.id === id)
    if (!target) return

    // If this highlight has a note, ONLY remove the highlight color/shape from the text; NEVER delete the note!
    if (target.noteId && (target.color !== 'transparent' || target.shape !== 'none')) {
      highlightsDirtyRef.current = true
      highlightElements(id).forEach((mark) => {
        mark.style.cssText = `${highlightStyle('none', 'transparent')} color:inherit;`
      })
      setHighlights((items) => items.map((item) => item.id === id ? { ...item, color: 'transparent', shape: 'none' } : item))
      return
    }

    // If there is no note attached, or it's already transparent, delete the card and mark
    deleteAnnotationCard(id)
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

  const pageMarkdown = () => {
    const pageHighlights = highlights.map((item) => {
      const note = allNotes.find(({ note: candidate }) => candidate.id === item.noteId)?.note
      const link = `${pageUrl}#:~:text=${encodeURIComponent(item.text)}`
      return `> ${item.text}\n\n[Open passage](${link})${note?.body.trim() ? `\n\n${cleanNoteBody(note.body).trim()}` : ''}`
    })
    const attachedNoteIds = new Set(highlights.flatMap((item) => item.noteId ? [item.noteId] : []))
    const standaloneNotes = notes.filter((note) => !attachedNoteIds.has(note.id)).map((note) => `### ${note.title.trim() || 'Untitled note'}\n\n${cleanNoteBody(note.body).trim() || '_No content_'}`)
    return `# ${pageTitle}\n\nPage: ${pageUrl}\n\n${pageHighlights.length ? `## Highlights\n\n${pageHighlights.join('\n\n---\n\n')}` : ''}${standaloneNotes.length ? `${pageHighlights.length ? '\n\n' : ''}## Notes\n\n${standaloneNotes.join('\n\n---\n\n')}` : ''}`.trim() + '\n'
  }

  const exportPageMarkdown = () => {
    const blob = new Blob([pageMarkdown()], { type: 'text/markdown;charset=utf-8' })
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `${safeHostname(pageUrl).replace(/[^a-z0-9.-]/gi, '-')}-devnotes.md`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
  }

  const copyPageMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(pageMarkdown())
      setImportError('Copied this page as Markdown.')
    } catch {
      setImportError('Clipboard access is unavailable. Use Export page to save the Markdown file.')
    }
  }

  const openReviewItem = (item?: ReviewItem) => {
    if (!item) return
    setReviewOpen(false)
    if (item.note) {
      setSelectedPageUrl(item.url)
      setSelectedId(item.note.id)
      setShowAllNotes(true)
      setShowArchived(false)
      setShowFavorites(false)
      setShowTasks(false)
      setShowTrash(false)
      setOpen(true)
      return
    }
    if (item.url === pageUrl) highlightElements(item.id)[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    else window.open(item.url, '_blank', 'noopener,noreferrer')
  }

  const exportJSON = async () => {
    const backup: BackupFile = { format: 'devnotes-backup', version: 1, pages, collections, highlights: await readHighlights(), trash, settings, pageMeta: allPageMeta }
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
      const importedPageMeta = backup.pageMeta ?? {}
      clearPageHighlights()
      setPages(importedPages)
      pagesVersionRef.current += 1
      setDeletedNotes({})
      setCollections(importedCollections)
      setTrash(importedTrash)
      setSettings(importedSettings)
      setAllPageMeta(importedPageMeta)
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
      if (typeof chrome !== 'undefined' && chrome.storage?.local && !isIncognitoContext()) {
        await new Promise<void>((resolve, reject) => chrome.storage.local.set({ [STORAGE_KEY]: importedPages, [DELETED_KEY]: {}, [COLLECTION_KEY]: importedCollections, [TRASH_KEY]: importedTrash, [HIGHLIGHT_KEY]: importedHighlights, [SETTINGS_KEY]: importedSettings, [PAGEMETA_KEY]: importedPageMeta }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()))
      } else if (isIncognitoContext()) {
        // The imported data stays in this panel's in-memory state only.
      } else if (typeof chrome !== 'undefined' && chrome.runtime) {
        throw new Error('Chrome storage is unavailable.')
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(importedPages))
        localStorage.setItem(DELETED_KEY, '{}')
        localStorage.setItem(COLLECTION_KEY, JSON.stringify(importedCollections))
        localStorage.setItem(TRASH_KEY, JSON.stringify(importedTrash))
        localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(importedHighlights))
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(importedSettings))
        localStorage.setItem(PAGEMETA_KEY, JSON.stringify(importedPageMeta))
      }
      setOrphanedHighlights(applyHighlights(importedHighlights[pageUrl] ?? []))
      setImportError('Backup restored.')
    } catch { setImportError('Could not read this backup file.') }
  }

  const captureSelection = useCallback((action: 'highlight' | 'note' | 'sticky' = 'note', color = settings.highlightColor): boolean => {
    const selection = window.getSelection()
    let text = ''
    let prefix = ''
    let suffix = ''
    let start = 0
    let end = 0
    const nodes = pageTextNodes()
    const pageText = nodes.map((node) => node.textContent ?? '').join('')

    if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim()) {
      const range = selection.getRangeAt(0)
      start = pageTextOffset(nodes, range.startContainer, range.startOffset)
      end = pageTextOffset(nodes, range.endContainer, range.endOffset)
      const selectedText = pageText.slice(start, end)
      text = selectedText.trim()
      if (text) {
        start += selectedText.length - selectedText.trimStart().length
        end = start + text.length
        prefix = pageText.slice(Math.max(0, start - 80), start)
        suffix = pageText.slice(end, Math.min(pageText.length, end + 80))
      }
    }

    // Anchor free placement too if sticky or note requested without text selection
    if (!text && (action === 'sticky' || action === 'note')) {
      const anchor = findNearestTextAnchor(window.innerWidth / 2, window.innerHeight / 3)
      if (anchor) {
        text = anchor.text
        prefix = anchor.prefix
        suffix = anchor.suffix
        start = anchor.start
        end = anchor.end
      }
    }

    if (!text) {
      setImportError("This page doesn't expose selectable text. You can still write a page note from the panel.")
      if (action !== 'highlight') createNote()
      return false
    }

    const item: Highlight = {
      id: crypto.randomUUID(),
      text,
      prefix,
      suffix,
      color: action === 'note' ? 'transparent' : color,
      createdAt: Date.now(),
      shape: action === 'note' ? 'none' : settings.highlightStyle,
      display: action === 'sticky' ? 'sticky' : 'inline',
      placement: { side: 'right', dx: 24, dy: 0 },
      status: 'attached',
    }

    wrapTextOffsets(nodes, start, end, item.id, item.color, item.shape)
    highlightsDirtyRef.current = true
    setOrphanedHighlights((items) => items.filter((id) => id !== item.id))
    setHighlights([...highlights, item])
    if (action !== 'highlight') setEditingId(item.id)
    return true
  }, [createNote, highlights, settings.highlightColor, settings.highlightStyle])
  useEffect(() => { captureSelectionRef.current = captureSelection }, [captureSelection])

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
    const onCapture = () => { if (!captureSelection('note')) setOpen(true) }
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

  const annotationPlacements = useMemo<AnnotationPlacement[]>(() => {
    void annotationLayoutTick
    if (!document.body) return []

    const scrollX = window.pageXOffset ?? window.scrollX ?? 0
    const scrollY = window.pageYOffset ?? window.scrollY ?? 0
    const pageWidth = document.documentElement.clientWidth || window.innerWidth
    const contentColumn = findContentColumn()
    const columnLeft = contentColumn ? contentColumn.left + scrollX : 0
    const columnRight = contentColumn ? contentColumn.right + scrollX : pageWidth
    const panelWidth = open ? Math.min(settings.panelWidth, pageWidth) : 0
    const visibleLeft = open && settings.panelSide === 'left' ? panelWidth : 0
    const visibleRight = open && settings.panelSide === 'right' ? pageWidth - panelWidth : pageWidth

    type AttachedItem = {
      item: Highlight
      index: number
      rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }
      note?: Note
    }

    const attached: AttachedItem[] = []
    for (let index = 0; index < highlights.length; index++) {
      const item = highlights[index]
      const mark = highlightElements(item.id)[0]
      if (!mark) continue
      const r = mark.getBoundingClientRect()
      attached.push({
        item,
        index,
        rect: {
          left: r.left + scrollX,
          top: r.top + scrollY,
          right: r.right + scrollX,
          bottom: r.bottom + scrollY,
          width: r.width,
          height: r.height,
        },
        note: allNotes.find(({ note }) => note.id === item.noteId)?.note,
      })
    }

    // Step 5: Stack notes in page space (sort top-to-bottom by anchor)
    attached.sort((a, b) => a.rect.top - b.rect.top)

    let rightLastBottom = 16
    let leftLastBottom = 16
    const placements: AnnotationPlacement[] = []

    for (const entry of attached) {
      const { item, index, rect, note } = entry
      const anchorCenterY = rect.top + rect.height / 2
      const rightSpace = visibleRight + scrollX - columnRight
      const leftSpace = columnLeft - (visibleLeft + scrollX)

      // If user manually placed the note anywhere on the page:
      if (item.placement?.manual && typeof item.placement.dx === 'number' && typeof item.placement.dy === 'number') {
        const y = rect.top + item.placement.dy
        const preferred = item.placement.side === 'left' ? 'left' : 'right'
        const side = preferred === 'right' && rightSpace >= 260 ? 'right' : preferred === 'left' && leftSpace >= 260 ? 'left' : rightSpace >= 260 ? 'right' : leftSpace >= 260 ? 'left' : 'marker'
        const x = side === 'left' ? columnLeft - 260 : side === 'right' ? columnRight + 10 : rect.right + scrollX
        placements.push({
          item,
          index,
          side,
          x,
          y,
          anchorX: side === 'right' ? rect.right : rect.left,
          anchorY: anchorCenterY,
          rect,
          note,
        })
        continue
      }

      if (!note && editingId !== item.id) {
        placements.push({ item, index, side: 'marker', x: rect.left, y: rect.bottom, anchorX: rect.left, anchorY: rect.bottom, rect })
        continue
      }

      // Margin cards vs inline
      const canFitRight = rightSpace >= 260
      const canFitLeft = leftSpace >= 260

      let side: 'left' | 'right' | 'marker' = 'marker'
      if (canFitRight || canFitLeft) side = canFitRight && canFitLeft
        ? (rightSpace >= leftSpace ? 'right' : 'left')
        : canFitRight ? 'right' : 'left'

      if (side === 'marker') {
        placements.push({ item, index, side: 'marker', x: rect.right + scrollX, y: rect.top + scrollY, anchorX: rect.left, anchorY: rect.bottom, rect, note })
      } else {
        const isRight = side === 'right'
        const lastBottom = isRight ? rightLastBottom : leftLastBottom
        const desiredY = Math.max(anchorCenterY - 24, lastBottom + 12)
        const y = desiredY
        const cardHeight = Math.min(260, 52 + Math.ceil(cleanNoteBody(note?.body ?? '').length / 26) * 20)
        if (isRight) rightLastBottom = y + cardHeight
        else leftLastBottom = y + cardHeight

        const x = isRight ? columnRight + 10 : columnLeft - 260
        placements.push({
          item,
          index,
          side,
          x,
          y,
          anchorX: isRight ? rect.right : rect.left,
          anchorY: anchorCenterY,
          rect,
          note,
        })
      }
    }

    return placements
  }, [allNotes, annotationLayoutTick, editingId, highlights, open, settings.panelSide, settings.panelWidth])

  const copyUnsavedText = async () => {
    const value = selected
      ? `${selected.title ? `${selected.title}\n\n` : ''}${selected.body}`
      : Object.entries(pages).flatMap(([url, items]) => items.map((note) => `${note.title || 'Untitled note'}\n${url}\n\n${note.body}`)).join('\n\n---\n\n')
    try {
      await navigator.clipboard.writeText(value || 'No note text is currently in memory.')
      setImportError('Copied the current in-memory notes.')
    } catch {
      setImportError('Clipboard access is unavailable. Select and copy the note text manually.')
    }
  }

  return <>
    {selectionToolbar && (
      <div
        className={`dn-selection-toolbar ${effectiveTheme === 'dark' ? 'dn-dark' : effectiveTheme === 'sepia' ? 'dn-theme-sepia' : ''}`}
        style={{ left: selectionToolbar.x, top: selectionToolbar.y }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => event.stopPropagation()}
        aria-label="Text annotation tools"
      >
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="dn-toolbar-color"
            aria-label={`Highlight with ${color}`}
            title={`Highlight with ${color}`}
            style={{ background: color }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const activeId = selectionToolbar.highlightIds?.[0]
              const selection = window.getSelection()
              const hasSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim())
              if (activeId && !hasSelection) {
                changeHighlightColor(activeId, color)
              } else {
                captureSelection('highlight', color)
                selection?.removeAllRanges()
              }
              setSelectionToolbar(null)
            }}
          />
        ))}
        <span className="dn-toolbar-divider" />
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const activeId = selectionToolbar.highlightIds?.[0]
            const selection = window.getSelection()
            const hasSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim())
            if (activeId && !hasSelection) {
              setEditing(activeId, true)
            } else {
              captureSelection('note')
              selection?.removeAllRanges()
            }
            setSelectionToolbar(null)
          }}
        >
          Note
        </button>
        <button
          type="button"
          title="Add a sticky note beside this passage"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            captureSelection('sticky')
            window.getSelection()?.removeAllRanges()
            setSelectionToolbar(null)
          }}
        >
          Sticky
        </button>
        {selectionToolbar.highlightIds && selectionToolbar.highlightIds.length > 0 && (
          <>
            <span className="dn-toolbar-divider" />
            <button
              type="button"
              className="dn-toolbar-delete"
              title="Remove highlight from text"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const ids = selectionToolbar.highlightIds ?? []
                ids.forEach((id) => removeHighlight(id))
                window.getSelection()?.removeAllRanges()
                setSelectionToolbar(null)
              }}
            >
              Remove highlight
            </button>
          </>
        )}
      </div>
    )}

    {/* In-page annotations layer: anchored in document space, moves naturally with document scrolling */}
    <div className="dn-page-layer">
      {/* Dotted connectors: absolute in page space, full document height */}
      <svg
        className="dn-annotation-connectors"
        aria-hidden="true"
        style={{ height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight) }}
      >
        {annotationPlacements.filter(({ item, note, side }) => side !== 'marker' && (note || editingId === item.id)).map(({ item, anchorX, anchorY, x, y }) => {
          const cardWidth = 240
          const endX = x >= anchorX ? x : x + cardWidth
          const endY = y + 16
          return (
            <g key={item.id}>
              <circle cx={anchorX} cy={anchorY} r="3" />
              <path d={`M ${anchorX} ${anchorY} C ${(anchorX + endX) / 2} ${anchorY}, ${(anchorX + endX) / 2} ${endY}, ${endX} ${endY}`} />
            </g>
          )
        })}
      </svg>

      {/* Notes placed anywhere on the page */}
      {annotationPlacements.filter(({ item, note, side }) => side !== 'marker' && (note || editingId === item.id)).map(({ item, x, y, note }) => (
        <AnnotationCard
          key={item.id}
          item={item}
          x={x}
          y={y}
          body={cleanNoteBody(note?.body ?? '')}
          editing={editingId === item.id}
          penSet={settings.penSet}
          noteFont={settings.noteFont}
          themeMode={effectiveTheme}
          onChange={(text) => setAnnotationText(item, text)}
          onEditingChange={(on) => setEditing(item.id, on)}
          onToggleTask={(index, done) => { if (note) toggleInlineTask(note.id, index, done) }}
          onColor={() => cycleHighlightColor(item)}
          onOpen={() => openAnnotationNote(item)}
          onRemove={() => deleteAnnotationCard(item.id)}
          onMove={(newX, newY) => moveNote(item.id, newX, newY)}
        />
      ))}
      {annotationPlacements.filter(({ side }) => side === 'marker').map(({ item, index, rect, note }) => (
        <button
          key={`marker-${item.id}`}
          className="dn-inline-marker"
          style={{ left: rect.right + (window.scrollX ?? 0) - 10, top: rect.top + (window.scrollY ?? 0) - 10 }}
          title={note ? `Open note ${index + 1}` : `Highlight ${index + 1}; no article gutter is available for a note card`}
          aria-label={note ? `Open attached note ${index + 1}` : `Highlight ${index + 1}`}
          onClick={() => {
            if (note) {
              const entry = allNotes.find(({ note: candidate }) => candidate.id === note.id)
              setSelectedPageUrl(entry?.url ?? pageUrl)
              setSelectedId(note.id)
              setShowAllNotes(false)
              setOpen(true)
            } else {
              const mark = highlightElements(item.id)[0]
              const box = mark?.getBoundingClientRect()
              if (box) setSelectionToolbar({ x: Math.max(8, Math.min(window.innerWidth - 260, box.left + box.width / 2 - 120)), y: Math.max(8, box.top - 54), highlightIds: [item.id] })
            }
          }}
        >{index + 1}</button>
      ))}
    </div>

    {/* Fixed rail minimap */}
    <div className={`dn-annotation-rail ${effectiveTheme === 'dark' ? 'dn-dark' : effectiveTheme === 'sepia' ? 'dn-theme-sepia' : ''}`} aria-label="Page annotations">
      {annotationPlacements.map(({ item, rect }) => {
        const docHeight = Math.max(1, document.documentElement.scrollHeight, document.body?.scrollHeight ?? 1)
        const pct = Math.max(1, Math.min(99, (rect.top / docHeight) * 100))
        return (
          <button
            key={item.id}
            style={{
              top: `${pct}%`,
              background: darkTheme ? 'var(--dn-accent)' : item.color === 'transparent' ? 'var(--dn-accent)' : item.color,
            }}
            title={item.text ? `Jump to: “${item.text.slice(0, 35)}${item.text.length > 35 ? '…' : ''}”` : 'Jump to highlight'}
            aria-label="Jump to highlight"
            onClick={() => highlightElements(item.id)[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        )
      })}
    </div>

    {!open && !settings.hideLauncher && <button className={`dn-launcher ${settings.launcherPosition === 'bottom-left' ? 'dn-launcher-left' : ''} ${effectiveTheme === 'dark' ? 'dn-dark' : effectiveTheme === 'sepia' ? 'dn-theme-sepia' : ''}`} onClick={() => setOpen(true)} aria-label="Open DevNotes" title="DevNotes"><span className="dn-mark">d<span>.</span></span></button>}

    <aside className={`dn-panel dn-theme-${effectiveTheme} dn-font-${settings.noteFont} ${libraryOpen ? 'dn-library-open' : 'dn-page-view'} ${open ? 'is-open' : ''} ${settings.panelSide === 'left' ? 'dn-panel-left' : ''} ${darkTheme ? 'dn-dark' : ''}`} style={{ width: `min(${settings.panelWidth}px, 100vw)`, left: settings.panelSide === 'left' ? 0 : 'auto', right: settings.panelSide === 'right' ? 0 : 'auto', '--dn-text-scale': settings.textSize === 'small' ? 0.92 : settings.textSize === 'large' ? 1.15 : 1 } as CSSProperties} aria-label="DevNotes panel" aria-hidden={!open}>
      <header className="dn-header">
        <div className="dn-brand"><span className="dn-brand-icon">d<span>.</span></span><span>devnotes</span></div>
        {personalizeOpen && <section className="dn-personalize" role="dialog" aria-label="Annotation appearance"><div><strong>Annotation appearance</strong><button className="dn-icon-button" onClick={() => setPersonalizeOpen(false)} aria-label="Close annotation appearance">×</button></div><label>Highlight shape<select value={settings.highlightStyle} onChange={(event) => updateSettings({ highlightStyle: event.target.value as DevNotesSettings['highlightStyle'] })}><option value="marker">Marker fill</option><option value="underline">Wavy question</option><option value="box">Box reminder</option><option value="bracket">Margin bracket</option></select></label><label>Pen set<select value={settings.penSet} onChange={(event) => updateSettings({ penSet: event.target.value as DevNotesSettings['penSet'] })}><option value="marker">Marker</option><option value="pencil">Pencil</option><option value="fountain">Fountain pen</option></select></label><label>Note font<select value={settings.noteFont} onChange={(event) => updateSettings({ noteFont: event.target.value as DevNotesSettings['noteFont'] })}><option value="serif">Book serif</option><option value="handwriting">Handwriting</option><option value="mono">Monospace</option></select></label></section>}
        <button className="dn-icon-button" onClick={() => setPersonalizeOpen(true)} aria-label="Personalize annotations" title="Annotation styles">◐</button>
        <button className="dn-library-toggle" onClick={() => { const next = !libraryOpen; setLibraryOpen(next); setShowAllNotes(next); if (!next) { setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) } }}>{libraryOpen ? 'This page' : 'Library'}</button>
        <button className="dn-icon-button dn-site-disable" onClick={() => void disableOnThisSite()} aria-label={`Disable DevNotes on ${hostname}`} title="Disable on this site">◉</button>
        <button className="dn-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open DevNotes settings" title="Settings">⚙</button>
        <button className="dn-icon-button" onClick={() => setOpen(false)} aria-label="Close panel">×</button>
      </header>

      {(runtimeInvalid || saveState === 'error') && <div className="dn-recovery-banner" role="alert"><span>{runtimeInvalid ? 'DevNotes was updated, reload this tab.' : 'DevNotes could not save. Your text is still in memory.'}</span><button onClick={() => void copyUnsavedText()}>Copy notes</button></div>}
      {incognitoMode && <div className="dn-privacy-banner" role="status">Incognito mode: notes stay in memory for this tab.</div>}

      {settingsOpen && <section className="dn-settings" role="dialog" aria-label="DevNotes settings"><div className="dn-settings-heading"><div><strong>Settings</strong><span>Preferences are stored on this device.</span></div><button className="dn-icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div><div className="dn-settings-content"><label>Theme<select value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as DevNotesSettings['theme'] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option><option value="sepia">Sepia</option></select></label><label>Selection toolbar<select value={settings.toolbarBehavior} onChange={(event) => updateSettings({ toolbarBehavior: event.target.value as DevNotesSettings["toolbarBehavior"] })}><option value="always">Always</option><option value="hold-alt">Hold Alt</option><option value="never">Never</option></select></label><label>Text size<select value={settings.textSize} onChange={(event) => updateSettings({ textSize: event.target.value as DevNotesSettings["textSize"] })}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label>Panel side<select value={settings.panelSide} onChange={(event) => updateSettings({ panelSide: event.target.value as DevNotesSettings['panelSide'] })}><option value="right">Right</option><option value="left">Left</option></select></label><label>Panel width <span>{settings.panelWidth}px</span><input type="range" min="360" max="720" step="10" value={settings.panelWidth} onChange={(event) => updateSettings({ panelWidth: Number(event.target.value) })} /></label><label>Launcher position<select value={settings.launcherPosition} onChange={(event) => updateSettings({ launcherPosition: event.target.value as DevNotesSettings['launcherPosition'] })}><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select></label><label className="dn-settings-check"><input type="checkbox" checked={settings.hideLauncher} onChange={(event) => updateSettings({ hideLauncher: event.target.checked })} />Hide the floating launcher</label><fieldset><legend>Default highlight color</legend><div className="dn-setting-colors">{HIGHLIGHT_COLORS.map((color) => <button key={color} type="button" className={settings.highlightColor === color ? 'selected' : ''} style={{ background: color }} aria-label={`Use highlight color ${color}`} onClick={() => updateSettings({ highlightColor: color })} />)}</div></fieldset><label>Trash retention <span>{settings.trashRetentionDays} days</span><input type="range" min="30" max="3650" step="30" value={settings.trashRetentionDays} onChange={(event) => updateSettings({ trashRetentionDays: Number(event.target.value) })} /></label><label>Version history <span>{settings.historyDepth} versions</span><input type="range" min="1" max="100" value={settings.historyDepth} onChange={(event) => updateSettings({ historyDepth: Number(event.target.value) })} /></label><div className="dn-site-settings"><strong>This site · {hostname}</strong><button onClick={() => void disableOnThisSite()}>Disable DevNotes on this site</button></div><form className="dn-blocklist-add" onSubmit={(event) => { event.preventDefault(); addBlockedHost(blocklistDraft); setBlocklistDraft('') }}><label htmlFor="dn-block-host">Block another site</label><div><input id="dn-block-host" value={blocklistDraft} onChange={(event) => setBlocklistDraft(event.target.value)} placeholder="example.com" /><button type="submit">Add</button></div></form><div className="dn-blocklist"><strong>Blocked sites</strong>{settings.disabledHosts.length ? settings.disabledHosts.map((host) => <div key={host}><span>{host}</span><button aria-label={`Unblock ${host}`} onClick={() => allowHost(host)}>Allow</button></div>) : <small>No custom sites blocked.</small>}<strong>Default protected sites</strong>{DEFAULT_BLOCKED_HOSTS.map((host) => { const allowed = settings.enabledHosts.some((rule) => hostMatches(hostname, rule)) && hostMatches(hostname, host); return <div key={host}><span>{host}</span><button aria-label={`${allowed ? 'Block' : 'Allow'} DevNotes on ${host}`} onClick={() => allowed ? addBlockedHost(host) : allowHost(host)}>{allowed ? 'Block' : 'Allow'}</button></div> })}</div></div></section>}

      {onboardingStep !== null && <div className="dn-modal-backdrop"><section className="dn-onboarding" role="dialog" aria-modal="true" aria-label="Welcome to DevNotes"><span className="dn-onboarding-step">STEP {onboardingStep + 1} OF 3</span><h2>{['Keep notes beside the source', 'Make a reading trail', 'Find it again'][onboardingStep]}</h2><p>{[
        'Select a passage and choose Note or Sticky. Your annotation appears beside the page, and the note is created when you start typing.',
        'Set a reading status, save why a page matters, add tasks, and write a dated journal entry as you read.',
        'Use Library search, collections, tags, and Review to return to useful notes. Export Markdown or make a local backup whenever you need it.',
      ][onboardingStep]}</p><div className="dn-onboarding-actions"><button onClick={completeOnboarding}>Skip</button>{onboardingStep > 0 && <button onClick={() => setOnboardingStep((step) => Math.max(0, (step ?? 1) - 1))}>Back</button>}<button className="primary" onClick={() => onboardingStep === 2 ? completeOnboarding() : setOnboardingStep(onboardingStep + 1)}>{onboardingStep === 2 ? 'Get started' : 'Continue'}</button></div></section></div>}
      <div className="dn-page">
        <div className="dn-site-icon">{hostname[0]?.toUpperCase()}</div>
        <div className="dn-page-copy"><strong>{hostname}</strong><span title={pageTitle}>{pageTitle}</span></div>
        <button className="dn-clip" title="Clip the main article" onClick={clipArticle}>Clip</button>
        <button className="dn-clip" title="Copy page notes and highlights as Markdown" onClick={() => void copyPageMarkdown()}>Copy</button>
        <button className="dn-clip" title="Export page notes and highlights as Markdown" onClick={exportPageMarkdown}>Export</button>
        <button className="dn-icon-button dn-more" title="Highlight selection and save as a note" aria-label="Capture selected text" onClick={() => captureSelection()}>✳</button>
      </div>

      {!showAllNotes && !showTrash && <section className="dn-page-extras" aria-label="Page reading details">
        <div className="dn-section-hdr">Reading status</div>
        <div className="dn-status-group">{([['to-read', 'To read'], ['reading', 'Reading'], ['done', 'Done']] as const).map(([status, label]) => <button key={status} className={`dn-status-btn ${pageMeta.status === status ? 'active' : ''}`} onClick={() => updatePageMeta({ status })}>{label}</button>)}</div>
        <label className="dn-section-hdr" htmlFor="dn-why-saved">Why I saved this</label>
        <input id="dn-why-saved" className="dn-why-input" value={pageMeta.whySaved} placeholder="What made this page worth keeping?" onChange={(event) => updatePageMeta({ whySaved: event.target.value })} />
        <div className="dn-section-hdr">Page tasks</div>
        <div className="dn-tasks-box">{pageMeta.tasks.map((task) => <label key={task.id} className={`dn-task-item ${task.done ? 'is-done' : ''}`}><input type="checkbox" checked={task.done} onChange={(event) => updatePageMeta({ tasks: pageMeta.tasks.map((item) => item.id === task.id ? { ...item, done: event.target.checked } : item) })} /><span>{task.text}</span><button type="button" aria-label={`Remove task ${task.text}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); updatePageMeta({ tasks: pageMeta.tasks.filter((item) => item.id !== task.id) }) }}>×</button></label>)}</div>
        <form className="dn-add-task-form" onSubmit={(event) => { event.preventDefault(); addPageTask() }}><input aria-label="Add a page task" placeholder="Add a next step…" value={pageTaskDraft} onChange={(event) => setPageTaskDraft(event.target.value)} /><button type="submit">Add</button></form>
        {availableTags.length > 0 && <><div className="dn-section-hdr">Page tags</div><div className="dn-pill-tags">{availableTags.filter((tag) => notes.some((note) => note.tags?.includes(tag))).map((tag) => <span key={tag} className="dn-pill-tag">{tag}</span>)}</div></>}
        <div className="dn-section-hdr">Today's journal · {todayKey}</div>
        <textarea className="dn-today-box" aria-label="Today's journal entry" placeholder="What stood out on this page today?" value={todayJournal} onChange={(event) => updateTodayJournal(event.target.value)} />
        {Object.entries(pageMeta.journalEntries ?? {}).filter(([date, entry]) => date !== todayKey && entry.trim()).sort(([a], [b]) => b.localeCompare(a)).slice(0, 3).map(([date, entry]) => <div className="dn-journal-history" key={date}><strong>{date}</strong><span>{entry}</span></div>)}
        <div className="dn-extra-actions"><button onClick={() => setShowDailyReview((value) => !value)}>{showDailyReview ? 'Hide' : 'What I read today'} <span>{dailyReviewItems.length}</span></button><button onClick={() => { setReviewScope('site'); setReviewIndex(0); setReviewOpen(true) }}>Review this site</button></div>
        {showDailyReview && <div className="dn-today-review">{dailyReviewItems.length ? dailyReviewItems.map((item) => <article key={`${item.kind}:${item.id}`}><strong>{item.title}</strong><p>{item.text || 'No note text'}</p><small>{safeHostname(item.url)} · {item.kind}</small></article>) : <p>No notes or annotations added today yet.</p>}</div>}
        <div className="dn-section-hdr">Related notes</div>
        <div className="dn-related-list">{allNotes.filter(({ note }) => note.id && (note.tags ?? []).some((tag) => notes.some((pageNote) => pageNote.tags?.includes(tag))) && !notes.some((pageNote) => pageNote.id === note.id)).slice(0, 4).map(({ note, url }) => <button className="dn-related-item" key={note.id} onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id); setShowAllNotes(true) }}><span>{note.title || 'Untitled note'}</span><span>{safeHostname(url)}</span></button>)}</div>
      </section>}

      {orphanedHighlights.length > 0 && (
        <div className="dn-orphans-card" role="region" aria-label="Lost anchors" style={{ margin: '0 24px 10px' }}>
          <div className="dn-orphans-title">
            <span>Lost Anchors · {orphanedHighlights.length}</span>
          </div>
          {orphanedHighlights.map((id) => {
            const item = highlights.find((h) => h.id === id)
            if (!item) return null
            return (
              <div key={id} className="dn-orphan-row">
                <span className="dn-orphan-text" title={item.text}>“{item.text.slice(0, 36)}{item.text.length > 36 ? '…' : ''}”</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button className="dn-reattach-btn" onClick={() => reattachHighlight(id)} title="Select new passage and click to reattach">Reattach</button>
                  <button className="dn-reattach-btn" style={{ borderColor: '#e4b6ad', color: '#8d6259' }} onClick={() => removeHighlight(id)} title="Delete orphan highlight">×</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {annotationUndo && <div className="dn-undo-toast" role="status"><span>Annotation deleted.</span><button onClick={undoAnnotationDelete}>Undo</button><button aria-label="Dismiss undo message" onClick={() => setAnnotationUndo(null)}>×</button></div>}

      <div className="dn-dashboard-tabs">
        <button className={!showAllNotes && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(false); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false); setCollectionFilter('') }}>This page</button>
        <button className={showAllNotes && !showArchived && !showFavorites && !showTasks && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>All notes</button>
        <button className={showTasks ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(true); setShowTrash(false) }}>Tasks</button>
        <button className={showFavorites ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(true); setShowTasks(false); setShowTrash(false) }}>Favorites</button>
        <button className={showArchived ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(true); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>Archived</button>
        <button className={showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowTrash(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false) }}>Trash</button>
      </div>
      <div className="dn-review-launch"><button onClick={() => { setReviewIndex(0); setReviewOpen(true) }}>Review notes & highlights</button></div>
      {reviewOpen && <section className="dn-review-dialog" role="dialog" aria-modal="true" aria-label="Review notes and highlights"><div className="dn-review-heading"><div><strong>Review</strong><span>{reviewItems.length ? `${Math.min(reviewIndex + 1, reviewItems.length)} of ${reviewItems.length}` : 'Nothing to review yet'}</span></div><button className="dn-icon-button" aria-label="Close review" onClick={() => setReviewOpen(false)}>×</button></div><div className="dn-review-filters"><label>Review by<select value={reviewScope} onChange={(event) => { setReviewScope(event.target.value as typeof reviewScope); setReviewIndex(0) }}><option value="site">This site</option><option value="tag">Tag</option></select></label>{reviewScope === 'tag' && <label>Tag<select value={reviewTag} onChange={(event) => { setReviewTag(event.target.value); setReviewIndex(0) }}><option value="">Choose a tag</option>{availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>}</div>{reviewItems.length ? <><article className="dn-review-item"><span>{reviewItems[reviewIndex]?.kind} · {safeHostname(reviewItems[reviewIndex]?.url ?? pageUrl)}</span><h2>{reviewItems[reviewIndex]?.title}</h2><p>{reviewItems[reviewIndex]?.text || 'No note text'}</p></article><div className="dn-review-controls"><button disabled={reviewIndex === 0} onClick={() => setReviewIndex((index) => Math.max(0, index - 1))}>Previous</button><button disabled={reviewIndex >= reviewItems.length - 1} onClick={() => setReviewIndex((index) => Math.min(reviewItems.length - 1, index + 1))}>Next</button><button className="primary" onClick={() => openReviewItem(reviewItems[reviewIndex])}>Open item</button></div></> : <div className="dn-empty">Select a site or tag with saved notes to begin.</div>}</section>}
      <div className="dn-page-heading">
        <h1>{showTrash ? 'Trash' : showArchived ? 'Archived' : showTasks ? 'Tasks' : showFavorites ? 'Favorites' : showAllNotes ? 'All notes' : 'Page notes'} <span>{showTrash ? trash.length : showArchived ? allNotes.filter(({ note }) => note.archived).length : showTasks ? allNotes.filter(({ note }) => !note.archived && /(?:^|\n)\s*[-*+]\s*\[ \]/.test(note.body)).length : showFavorites ? allNotes.filter(({ note }) => note.favorite && !note.archived).length : showAllNotes ? allNotes.filter(({ note }) => !note.archived).length : notes.filter((note) => !note.archived).length}</span></h1>
        <div className="dn-heading-actions">
          <button className="dn-export" onClick={exportMarkdown} disabled={!allNotes.length} title="Export all notes as Markdown">MD</button>
          <button className="dn-export" onClick={() => void exportJSON()} title="Export JSON backup">Backup</button>
          <button className="dn-export" onClick={() => importRef.current?.click()} title="Import JSON backup">Import</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importJSON(event.target.files?.[0]); event.currentTarget.value = '' }} />
          <select className="dn-template-select" aria-label="Create note from template" value="" onChange={(event) => { if (event.target.value) createFromTemplate(event.target.value as keyof typeof NOTE_TEMPLATES) }}><option value="">Template…</option>{Object.keys(NOTE_TEMPLATES).map((name) => <option key={name} value={name}>{name}</option>)}</select>
          <button className="dn-new" onClick={() => createNote()}><b>＋</b> New note</button>
        </div>
      </div>
      {showAllNotes && <div className="dn-collection-bar"><select aria-label="Filter by collection" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">All collections</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><input className="dn-domain-filter" aria-label="Filter by website domain" placeholder="Domain" value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} /><select aria-label="Sort notes" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="updated">Updated</option><option value="created">Created</option><option value="title">Title</option></select><input aria-label="Updated after" title="Updated after" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /><input aria-label="Updated before" title="Updated before" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /><button className="dn-collection-add" onClick={createCollection}>＋</button></div>}
      {showAllNotes && availableTags.length > 0 && <div className="dn-tag-browser"><strong>Tags</strong>{availableTags.map((tag) => <button key={tag} onClick={() => setQuery((value) => `${value} tag:"${tag}"`.trim())}>{tag}</button>)}</div>}
      {showAllNotes && bulkSelection.length > 0 && <div className="dn-bulk-actions"><strong>{bulkSelection.length} selected</strong><button onClick={() => setBulkTagEditing(true)}>Add tags</button><button onClick={() => bulkUpdate((note) => ({ ...note, archived: true }))}>Archive</button><button onClick={() => setBulkSelection([])}>Clear</button></div>}
      {bulkTagEditing && <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); applyBulkTags() }}><input autoFocus aria-label="Tags to add" placeholder="Tags, separated by commas" value={bulkTagDraft} onChange={(event) => setBulkTagDraft(event.target.value)} /><button type="submit">Apply</button><button type="button" onClick={() => { setBulkTagEditing(false); setBulkTagDraft('') }}>Cancel</button></form>}
      {addingCollection && <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); saveCollection() }}><input autoFocus aria-label="Collection name" placeholder="Collection name" value={collectionDraft} onChange={(event) => setCollectionDraft(event.target.value)} /><button type="submit">Create</button><button type="button" onClick={() => { setAddingCollection(false); setCollectionDraft('') }}>Cancel</button></form>}
      <label className="dn-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8" /><path d="m13.2 13.2 4 4" /></svg><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setLibraryOpen(true); setShowAllNotes(true) }} placeholder="Search notes" /><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd></label>
      {importError && <div className="dn-import-status" role="status">{importError}<button aria-label="Dismiss message" onClick={() => setImportError('')}>×</button></div>}
      {!ready ? <div className="dn-empty">Loading your notes…</div> : showTrash ? <div className="dn-trash-list">{trash.length ? trash.map((entry) => <div className="dn-trash-row" key={entry.note.id}><span><strong>{entry.note.title || 'Untitled note'}</strong><small>{safeHostname(entry.url)}</small></span><button className="dn-preview-toggle" onClick={() => restoreFromTrash(entry)}>Restore</button><button className="dn-delete" onClick={() => { const next = trash.filter((item) => item.note.id !== entry.note.id); setTrash(next); void writeTrash(next) }}>Delete forever</button></div>) : <div className="dn-empty">Trash is empty.</div>}</div> : !showAllNotes && notes.length === 0 && !query.trim() ? <div className="dn-empty-state"><div className="dn-empty-icon">✎</div><strong>A fresh page to think on.</strong><p>Keep the useful bits, questions, and ideas you find here.</p><button onClick={() => createNote()}>Write your first note <span>→</span></button><div className="dn-hint">TIP · SELECT TEXT ON THE PAGE, THEN TAP ✳</div></div> : filteredNotes.length === 0 ? <div className="dn-empty">{query.trim() ? `No notes match “${query}”.` : 'No notes here yet.'}</div> : <div className="dn-content">
        <div className="dn-note-list">{filteredNotes.map(({ note, url }) => <div key={`${url}:${note.id}`} className={`dn-note-row-wrap ${selectedPageUrl === url && selectedId === note.id ? 'active' : ''}`}>{showAllNotes && <input className="dn-bulk-check" type="checkbox" aria-label={`Select ${note.title || 'Untitled note'}`} checked={bulkSelection.includes(note.id)} onChange={(event) => setBulkSelection((ids) => event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id))} />}<button className="dn-note-row" onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}><span className="dn-note-dot" /><span className="dn-note-row-text"><strong>{note.pinned ? '📌 ' : ''}<SearchMatch text={note.title || 'Untitled note'} query={query} /></strong><small>{showAllNotes || query ? safeHostname(url) + ' · ' : ''}{note.body.trim().replace(/^>\s?/gm, '').slice(0, 58) || 'No content yet'}</small></span></button><button className={`dn-row-action ${note.favorite ? 'selected' : ''}`} title={note.favorite ? 'Remove favorite' : 'Add favorite'} aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleNoteFlag(note.id, 'favorite', url)}>{note.favorite ? '♥' : '♡'}</button><button className="dn-row-action" title={note.archived ? 'Restore from archive' : 'Archive note'} aria-label={note.archived ? 'Restore note' : 'Archive note'} onClick={() => toggleNoteFlag(note.id, 'archived', url)}>{note.archived ? '↶' : '▱'}</button></div>)}</div>
        {selected ? <article className="dn-editor"><div className="dn-editor-top"><span className="dn-note-type">NOTE</span><div className="dn-editor-actions"><button className={`dn-preview-toggle ${selected.pinned ? 'active' : ''}`} onClick={() => updateSelected({ pinned: !selected.pinned })}>{selected.pinned ? 'Unpin' : 'Pin'}</button><button className={`dn-preview-toggle ${selected.favorite ? 'active' : ''}`} onClick={() => updateSelected({ favorite: !selected.favorite })}>{selected.favorite ? '♥ Favorite' : '♡ Favorite'}</button><button className="dn-preview-toggle" onClick={() => setShowHistory((value) => !value)}>History</button><button className={`dn-preview-toggle ${preview ? 'active' : ''}`} onClick={() => setPreview((value) => !value)} aria-pressed={preview}>{preview ? 'Edit' : 'Preview'}</button><button className="dn-delete" onClick={deleteNote} title="Move note to trash">Delete</button></div></div><input className="dn-title" placeholder="Give this note a title…" value={selected.title} onChange={(event) => updateNote('title', event.target.value)} />{showHistory && <div className="dn-history-list">{(selected.history ?? []).length ? [...(selected.history ?? [])].reverse().map((revision) => <button key={revision.id} onClick={() => restoreRevision(revision)}><strong>{revision.title || 'Untitled note'}</strong><small>{new Date(revision.savedAt).toLocaleString()} · Restore</small></button>) : <small>No saved versions yet. Versions are captured during editing.</small>}</div>}{preview ? <div className="dn-markdown-preview" onChange={(event) => { const input = event.target as HTMLInputElement; if (input.matches('input[data-task-index]')) setTaskStatus(Number(input.dataset.taskIndex), input.checked) }} onClick={(event) => { const target = event.target as HTMLElement; const copy = target.closest<HTMLButtonElement>('[data-copy-code]'); if (copy) { const code = copy.parentElement?.querySelector('code')?.textContent ?? ''; void navigator.clipboard?.writeText(code).then(() => { copy.textContent = 'Copied' }) } const anchor = target.closest('a'); const href = anchor?.getAttribute('href'); if (href?.startsWith('#devnotes-note-id-')) { event.preventDefault(); openLinkedNote('id:' + decodeURIComponent(href.slice('#devnotes-note-id-'.length))) } else if (href?.startsWith('#devnotes-note-')) { event.preventDefault(); openLinkedNote(decodeURIComponent(href.slice('#devnotes-note-'.length))) } }} dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(selected.body || '*Nothing to preview yet.*') }} /> : <textarea className="dn-body" placeholder="Start writing…" value={selected.body} onChange={(event) => updateNote('body', event.target.value)} />}<LinkNoteInput notes={allNotes.filter(({ note }) => note.id !== selected.id)} onLink={(id, title) => updateNote('body', `${selected.body}\n[[id:${id}|${title}]]`)} /><div className="dn-collection-assign">{collections.length ? collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={selected.collectionIds?.includes(collection.id) ?? false} onChange={(event) => { const ids = selected.collectionIds ?? []; updateSelected({ collectionIds: event.target.checked ? [...ids, collection.id] : ids.filter((id) => id !== collection.id) }) }} />{collection.name}</label>) : <button className="dn-collection-add" onClick={createCollection}>＋ Create a collection</button>}</div><TagInput key={selected.id} tags={selected.tags ?? []} onCommit={(tags) => updateNote('tags', tags)} />{backlinks.length > 0 && <div className="dn-backlinks"><strong>Linked from</strong>{backlinks.map(({ note, url }) => <button key={note.id} onClick={() => { setSelectedPageUrl(url); setSelectedId(note.id) }}>{note.title || 'Untitled note'}</button>)}</div>}<div className="dn-editor-footer"><span><i />{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed · try editing again' : 'Saved locally'}</span></div></article> : null}
      </div>}
    </aside>
  </>
}

export default App
