import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DEFAULT_BLOCKED_HOSTS, DEFAULT_SETTINGS, HIGHLIGHT_COLORS, SETTINGS_KEY, hostMatches, isHostDisabled, normalizeHost, normalizeSettings, readSettings, writeSettings, type DevNotesSettings } from './settings'
import { cleanNoteBody, isRecord, mergePages, migratePages, normalizePageUrl, removeDeletedPages } from './storage/core'
import type { Collection, Highlight, Note, NoteCategory, NotePlacement, PageMeta, PageNotes, PageTask, TrashEntry } from './storage/types'
import { findBestAnchor } from './highlights/anchor'
import { TagInput } from './components/TagInput'
import { AnnotationCard } from './components/AnnotationCard'
import { TodoEditor } from './components/TodoEditor'
import { useSystemTheme } from './hooks/useSystemTheme'

type AnnotationPlacement = { item: Highlight; index: number; side: 'left' | 'right' | 'marker'; x: number; y: number; anchorX: number; anchorY: number; rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }; note?: Note }

const STORAGE_KEY = 'devnotes-pages'
const DELETED_KEY = 'devnotes-deleted-notes'
const HIGHLIGHT_KEY = 'devnotes-highlights'
const COLLECTION_KEY = 'devnotes-collections'
const TRASH_KEY = 'devnotes-trash'
const PAGEMETA_KEY = 'devnotes-pagemeta'
const SCHEMA_VERSION_KEY = 'devnotes-schema-version'
const CURRENT_SCHEMA_VERSION = 1
const isIncognitoContext = () => typeof chrome !== 'undefined' && Boolean(chrome.extension?.inIncognitoContext)

function stripMarkdownForUI(text: string): string {
  return text
    .replace(/^(\s*[-*+•–—]\s*(?:\[[ xX]?\]\s*)?|\s*\[[ xX]?\]\s*|#+\s+|>+\s*)/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function cleanDisplayTitle(note: Note): string {
  if (note.title && note.title.trim()) {
    return stripMarkdownForUI(note.title)
  }
  const firstLine = note.body.trim().split('\n')[0] ?? ''
  const cleaned = stripMarkdownForUI(firstLine).slice(0, 50)
  return cleaned || 'Untitled note'
}

function cleanDisplayPreview(note: Note): string {
  const content = note.title && note.title.trim()
    ? note.body
    : note.body.trim().split('\n').slice(1).join(' ')
  const cleaned = stripMarkdownForUI(content).slice(0, 58)
  return cleaned || 'No content yet'
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
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable. Reload Iris and refresh this page.')); return }
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
              color: [...HIGHLIGHT_COLORS, 'transparent'].includes(item.color as any) ? item.color : HIGHLIGHT_COLORS[0],
              shape: ['marker', 'underline', 'box', 'bracket', 'none'].includes(item.shape ?? '') ? item.shape : 'marker',
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

function findContentElement(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('article, main, [role="main"], [itemprop="articleBody"], .markdown-body, #content, .content, .article, .post-content'))
    .filter((element) => !element.closest('#devnotes-root') && (element.innerText?.length ?? 0) > 200)
    .sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))
  const fallback = Array.from(document.body?.children ?? [])
    .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.matches('nav, header, footer, aside, #devnotes-root') && (element.innerText?.length ?? 0) > 200)
    .sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0))[0]
  return candidates[0] ?? fallback ?? null
}

function findContentColumn() {
  const candidate = findContentElement()
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
    if (!node.parentNode) continue
    const text = node.textContent ?? ''
    const from = Math.max(0, start - offset)
    const to = Math.min(text.length, end - offset)
    if (to > from) {
      // Prevent wrapping inside an existing mark
      const existingMark = node.parentElement?.closest<HTMLElement>('mark[data-devnotes-highlight]')
      if (existingMark) {
        if (existingMark.dataset.devnotesHighlight === id) {
          existingMark.style.cssText = `${highlightStyle(shape, color, isDarkPageSurface(existingMark.parentElement))} color:inherit;`
          offset += text.length
          if (offset >= end) break
          continue
        }
        const p = existingMark.parentNode
        if (p) {
          while (existingMark.firstChild) p.insertBefore(existingMark.firstChild, existingMark)
          existingMark.remove()
          p.normalize()
        }
      }

      try {
        let targetNode = node
        if (from > 0) {
          targetNode = node.splitText(from)
        }
        if (to - from < (targetNode.textContent?.length ?? 0)) {
          targetNode.splitText(to - from)
        }
        const mark = document.createElement('mark')
        mark.dataset.devnotesHighlight = id
        mark.style.cssText = `${highlightStyle(shape, color, isDarkPageSurface(targetNode.parentElement))} color:inherit;`
        targetNode.parentNode?.insertBefore(mark, targetNode)
        mark.appendChild(targetNode)
      } catch {
        try {
          const range = document.createRange()
          range.setStart(node, from)
          range.setEnd(node, to)
          const mark = document.createElement('mark')
          mark.dataset.devnotesHighlight = id
          mark.style.cssText = `${highlightStyle(shape, color, isDarkPageSurface(node.parentElement))} color:inherit;`
          range.surroundContents(mark)
        } catch { /* Leave text visible if a site mutates the selected node mid-restore. */ }
      }
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
  const selector = id ? `mark[data-devnotes-highlight="${id}"]` : 'mark[data-devnotes-highlight]'
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
}

function clearPageHighlights() {
  while (true) {
    const marks = highlightElements()
    if (!marks.length) break
    const mark = marks[0]
    const parent = mark.parentNode
    if (parent) {
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      mark.remove()
      parent.normalize()
    } else {
      mark.remove()
    }
  }
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

function App({ messageTarget = window }: { messageTarget?: EventTarget }) {
  const [open, setOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const [categoryFilter, setCategoryFilter] = useState<NoteCategory | 'all'>('all')
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; highlightIds?: string[] } | null>(null)
  const [runtimeInvalid, setRuntimeInvalid] = useState(false)
  const [incognitoMode] = useState(() => isIncognitoContext())
  const [toolbarAltHeld, setToolbarAltHeld] = useState(false)
  const captureSelectionRef = useRef<(action?: 'highlight' | 'note', color?: string, shape?: Highlight['shape']) => boolean>(() => false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [hidePageAnnotations, setHidePageAnnotations] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dn-hide-annotations', hidePageAnnotations)
    return () => {
      document.documentElement.classList.remove('dn-hide-annotations')
    }
  }, [hidePageAnnotations])
  const [annotationLayoutTick, setAnnotationLayoutTick] = useState(0)
  const [, setOrphanedHighlights] = useState<string[]>([])
  const [highlightsForUrl, setHighlightsForUrl] = useState('')
  const highlightsRef = useRef(highlights)
  const isApplyingRef = useRef(false)
  const [showAllNotes, setShowAllNotes] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [showFavorites, setShowFavorites] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [sortMode, setSortMode] = useState<'updated' | 'created' | 'title'>('updated')
  const [domainFilter, setDomainFilter] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [bulkSelection, setBulkSelection] = useState<string[]>([])
  const [bulkTagEditing, setBulkTagEditing] = useState(false)
  const [bulkTagDraft, setBulkTagDraft] = useState('')
  const [bulkCollectionEditing, setBulkCollectionEditing] = useState(false)
  const [bulkCollectionTarget, setBulkCollectionTarget] = useState('')
  const [bulkNewCollectionName, setBulkNewCollectionName] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedPageUrl, setSelectedPageUrl] = useState(pageUrl)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [statusMessage, setStatusMessage] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
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
      setStatusMessage('Iris could not read local storage. Your edits will stay in memory until you copy them.')
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
      const pageHighlights = (saved[pageUrl] ?? []).filter((item) => !(item.color === 'transparent' && !item.noteId))
      setHighlights(pageHighlights)
      runApplyHighlights(pageHighlights)
      setHighlightsForUrl(pageUrl)
      observer = new MutationObserver((mutations) => {
        if (isApplying || isApplyingRef.current) return
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

  const updateNote = (field: 'title' | 'body' | 'tags' | 'collectionIds', value: string | string[]) => {
    if (!selected) return
    const history = selected.history ?? []
    const lastRevision = history[history.length - 1]
    const shouldSnapshot = field !== 'tags' && field !== 'collectionIds' && (!lastRevision || Date.now() - lastRevision.savedAt > 30_000)
    const updated: Note = field === 'tags'
      ? { ...selected, tags: value as string[], updatedAt: Date.now() }
      : field === 'collectionIds'
        ? { ...selected, collectionIds: value as string[], updatedAt: Date.now() }
        : { ...selected, [field]: value as string, updatedAt: Date.now() }
    if (shouldSnapshot) updated.history = [...history, { id: crypto.randomUUID(), title: selected.title, body: selected.body, savedAt: Date.now() }].slice(-settings.historyDepth)
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? updated : note) })
  }

  const deleteNote = (noteId?: string, noteUrl?: string) => {
    const targetId = noteId ?? selected?.id
    if (!targetId) return
    const targetUrl = noteUrl ?? selectedPageUrl
    const currentNotes = pages[targetUrl] ?? []
    const noteToDelete = currentNotes.find((n) => n.id === targetId) || allNotes.find(({ note }) => note.id === targetId)?.note
    if (!noteToDelete) return

    const remaining = currentNotes.filter((n) => n.id !== targetId)
    const nextPages = { ...pages, [targetUrl]: remaining }
    persist(nextPages)

    const nextTrash = boundedTrash([...trash, { note: noteToDelete, url: targetUrl, deletedAt: Date.now() }], settings.trashRetentionDays)
    setTrash(nextTrash)
    void writeTrash(nextTrash, settings.trashRetentionDays)
    setDeletedNotes((items) => ({ ...items, [targetId]: Date.now() }))

    void readHighlights().then((allHighlights) => {
      let changed = false
      for (const url of Object.keys(allHighlights)) {
        const updated = allHighlights[url].filter((item) => item.noteId !== targetId)
        if (updated.length !== allHighlights[url].length) { allHighlights[url] = updated; changed = true }
      }
      if (changed) void writeHighlights(allHighlights)
      if (targetUrl === pageUrl) {
        highlightElements().forEach((mark) => {
          if (highlights.find((item) => item.noteId === targetId)?.id === mark.dataset.devnotesHighlight) {
            mark.replaceWith(...Array.from(mark.childNodes))
          }
        })
        setHighlights((items) => items.filter((item) => item.noteId !== targetId))
      }
    })

    if (selectedId === targetId) {
      setSelectedId(remaining[0]?.id ?? null)
    }
    setAnnotationLayoutTick((t) => t + 1)
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

  const filteredNotes = useMemo(() => {
    const source = showAllNotes || deferredQuery.trim() || showTasks ? allNotes : notes.map((note) => ({ note, url: pageUrl }))
    const parsed = parseSearchQuery(deferredQuery)
    const from = parsed.after
    const to = parsed.before
    const matches = source.filter(({ note, url }) => {
      if (categoryFilter !== 'all' && (note.category || 'general') !== categoryFilter) return false
      const tags = (note.tags ?? []).map((tag) => tag.toLowerCase())
      const searchable = `${note.title} ${note.body} ${tags.join(' ')} ${url}`.toLowerCase()
      const task = /(?:^|\n)\s*[-*+]\s*\[([ xX])\]/.test(note.body) || note.category === 'todo'
      const quoted = /^\s*>/m.test(note.body)
      const host = safeHostname(url).toLowerCase()
      return Boolean(note.archived) === showArchived && (!showFavorites || Boolean(note.favorite)) && (!showTasks || task) && (!collectionFilter || note.collectionIds?.includes(collectionFilter)) && (!domainFilter || host.includes(domainFilter.toLowerCase())) && parsed.tags.every((tag) => tags.some((existing) => existing.includes(tag))) && parsed.sites.every((site) => host.includes(site)) && parsed.flags.every((flag) => flag === 'task' ? task : flag === 'favorite' ? Boolean(note.favorite) : flag === 'pinned' ? Boolean(note.pinned) : flag === 'quote' ? quoted : flag === 'archived' ? Boolean(note.archived) : true) && (!from || note.updatedAt >= from) && (!to || note.updatedAt <= to) && parsed.terms.every((term) => fuzzyContains(searchable, term))
    })
    const rank = (note: Note, url: string) => parsed.terms.reduce((score, term) => score + (note.title.toLowerCase().includes(term) ? 8 : note.body.toLowerCase().includes(term) ? 4 : safeHostname(url).toLowerCase().includes(term) ? 3 : 1), 0)
    return matches.sort((a, b) => Number(Boolean(b.note.pinned)) - Number(Boolean(a.note.pinned)) || (parsed.terms.length ? rank(b.note, b.url) - rank(a.note, a.url) : sortMode === 'title' ? a.note.title.localeCompare(b.note.title) : sortMode === 'created' ? b.note.createdAt - a.note.createdAt : b.note.updatedAt - a.note.updatedAt))
  }, [allNotes, notes, pageUrl, deferredQuery, showAllNotes, collectionFilter, showArchived, showFavorites, showTasks, domainFilter, sortMode, categoryFilter])

  const updateSelected = (patch: Partial<Note>) => {
    if (!selected) return
    persist({ ...pages, [selectedPageUrl]: selectedNotes.map((note) => note.id === selected.id ? { ...note, ...patch, updatedAt: Date.now() } : note) })
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

    const onMouseUp = (event: MouseEvent) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        const target = event.target as HTMLElement | null
        const mark = target?.closest<HTMLElement>('[data-devnotes-highlight]') ||
          event.composedPath().find((entry): entry is HTMLElement => entry instanceof HTMLElement && entry.hasAttribute('data-devnotes-highlight'))
        if (mark?.dataset.devnotesHighlight) {
          const id = mark.dataset.devnotesHighlight
          const rect = mark.getBoundingClientRect()
          setSelectionToolbar({
            x: Math.max(8, Math.min(window.innerWidth - 260, rect.left + rect.width / 2 - 120)),
            y: Math.max(8, rect.top - 54),
            highlightIds: [id],
          })
          return
        }
      }
      updateSelection(event.altKey)
    }
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
    style.textContent = `mark[data-devnotes-highlight]{cursor:pointer; transition:filter .12s;} mark[data-devnotes-highlight]:hover{filter:brightness(0.92);} .dn-hide-annotations mark[data-devnotes-highlight]{background:transparent !important; color:inherit !important; text-decoration:none !important; outline:none !important; border:none !important; box-shadow:none !important; cursor:auto !important; pointer-events:none !important;} .dn-hide-annotations .dn-page-layer{display:none !important;}`
    return () => { clearPageHighlights(); if (owned) style?.remove() }
  }, [])

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

  const applyBulkCollection = () => {
    let targetId = bulkCollectionTarget
    if (targetId === '__new__' || (collections.length === 0 && bulkNewCollectionName.trim())) {
      const name = bulkNewCollectionName.trim()
      if (!name) return
      const existing = collections.find((c) => c.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        targetId = existing.id
      } else {
        targetId = crypto.randomUUID()
        collectionsDirtyRef.current = true
        setCollections((items) => [...items, { id: targetId, name, createdAt: Date.now() }])
      }
    }
    if (!targetId || targetId === '__new__') return
    bulkUpdate((note) => ({
      ...note,
      collectionIds: [...new Set([...(note.collectionIds ?? []), targetId])],
    }))
    setBulkCollectionEditing(false)
    setBulkCollectionTarget('')
    setBulkNewCollectionName('')
  }

  const createCollection = () => {
    setAddingCollection(true)
  }

  const isTagInQuery = (tag: string) => {
    const clean = tag.replace(/^#/, '')
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(?:^|\\s)tag:(?:"${escaped}"|${escaped})(?=\\s|$)`, 'i')
    return regex.test(query)
  }

  const toggleTagInQuery = (tag: string) => {
    const clean = tag.replace(/^#/, '')
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const testRegex = new RegExp(`(?:^|\\s)tag:(?:"${escaped}"|${escaped})(?=\\s|$)`, 'i')
    const replaceRegex = new RegExp(`(?:^|\\s)tag:(?:"${escaped}"|${escaped})(?=\\s|$)`, 'gi')
    if (testRegex.test(query)) {
      const nextQuery = query.replace(replaceRegex, '').replace(/\s+/g, ' ').trim()
      setQuery(nextQuery)
    } else {
      const tagClause = `tag:"${clean}"`
      const nextQuery = query.trim() ? `${query.trim()} ${tagClause}` : tagClause
      setQuery(nextQuery)
    }
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
    if (collections.some((collection) => collection.name.toLowerCase() === name.toLowerCase())) { setStatusMessage('A collection with that name already exists.'); return }
    collectionsDirtyRef.current = true
    setCollections((items) => [...items, { id: crypto.randomUUID(), name, createdAt: Date.now() }])
    setCollectionDraft('')
    setAddingCollection(false)
  }

  const changeHighlightColor = (id: string, color: string) => {
    const target = highlights.find((item) => item.id === id)
    if (!target) return
    const nextShape = (!target.shape || target.shape === 'none') ? 'marker' : target.shape
    highlightElements(id).forEach((mark) => {
      mark.style.cssText = `${highlightStyle(nextShape, color, isDarkPageSurface(mark.parentElement))} color:inherit;`
    })
    const nextHighlights = highlights.map((item) => item.id === id ? { ...item, color, shape: nextShape } : item)
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
  }

  const changeHighlightShape = (id: string, shape: Highlight['shape']) => {
    const target = highlights.find((item) => item.id === id)
    if (!target) return
    const nextShape = (!shape || shape === 'none') ? 'marker' : shape
    const nextColor = (!target.color || target.color === 'transparent') ? settings.highlightColor : target.color
    highlightElements(id).forEach((mark) => {
      mark.style.cssText = `${highlightStyle(nextShape, nextColor, isDarkPageSurface(mark.parentElement))} color:inherit;`
    })
    const nextHighlights: Highlight[] = highlights.map((item) => item.id === id ? { ...item, shape: nextShape, color: nextColor } : item)
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
    updateSettings({ highlightStyle: nextShape })
  }

  const moveNote = (id: string, droppedPageX: number, droppedPageY: number) => {
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

    const nextHighlights = highlights.map((item) => {
      if (item.id !== id) return item
      return {
        ...item,
        placement: { side, dx, dy, manual: true },
        stickyX: undefined,
        stickyY: undefined,
      }
    })
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
  }

  const setEditing = (id: string, on: boolean) => setEditingId((current) => on ? id : current === id ? null : current)

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
    const note: Note = { id: crypto.randomUUID(), title: '', body: text, category: 'general', tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
    persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
    const nextHighlights = highlights.map((entry) => entry.id === item.id ? { ...entry, noteId: note.id } : entry)
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
  }

  const setAnnotationCategory = (item: Highlight, category: NoteCategory) => {
    if (item.noteId) {
      const noteUrl = allNotes.find(({ note }) => note.id === item.noteId)?.url ?? pageUrl
      persist({ ...pages, [noteUrl]: (pages[noteUrl] ?? []).map((note) => note.id === item.noteId ? { ...note, category, updatedAt: Date.now() } : note) })
    } else {
      const now = Date.now()
      const note: Note = { id: crypto.randomUUID(), title: '', body: '', category, tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
      persist({ ...pages, [pageUrl]: [note, ...(pages[pageUrl] ?? [])] })
      const nextHighlights = highlights.map((entry) => entry.id === item.id ? { ...entry, noteId: note.id } : entry)
      highlightsRef.current = nextHighlights
      setHighlights(nextHighlights)
      void readHighlights().then((saved) => {
        saved[pageUrl] = nextHighlights
        return writeHighlights(saved)
      })
    }
  }

  const toggleInlineTask = (noteId: string, lineIndex: number, done: boolean) => {
    const note = selectedNotes.find((n) => n.id === noteId) || allNotes.find(({ note: n }) => n.id === noteId)?.note
    if (!note) return
    const lines = note.body.split('\n')
    if (lineIndex >= 0 && lineIndex < lines.length) {
      const line = lines[lineIndex]
      const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/)
      if (match) {
        lines[lineIndex] = line.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, `$1${done ? 'x' : ' '}$2`)
      } else {
        lines[lineIndex] = `- [${done ? 'x' : ' '}] ${line.replace(/^\s*[-*+]\s+/, '')}`
      }
    } else {
      let index = 0
      lines.forEach((line, i) => {
        if (/^\s*[-*+]\s+\[([ xX])\]/.test(line)) {
          if (index === lineIndex) {
            lines[i] = line.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, `$1${done ? 'x' : ' '}$2`)
          }
          index++
        }
      })
    }
    const updatedBody = lines.join('\n')
    const noteUrl = selectedNotes.some((n) => n.id === noteId) ? selectedPageUrl : (allNotes.find(({ note: n }) => n.id === noteId)?.url ?? pageUrl)
    persist({
      ...pages,
      [noteUrl]: (pages[noteUrl] ?? []).map((n) => n.id === noteId ? { ...n, body: updatedBody, updatedAt: Date.now() } : n),
    })
  }

  const deleteAnnotationCard = (id: string) => {
    isApplyingRef.current = true
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
    if (target?.noteId) {
      const noteUrl = allNotes.find(({ note }) => note.id === target.noteId)?.url ?? pageUrl
      const noteObj = (pages[noteUrl] ?? []).find((note) => note.id === target.noteId)
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
    const nextHighlights = highlightsRef.current.filter((item) => item.id !== id)
    highlightsRef.current = nextHighlights
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
    setEditingId((current) => current === id ? null : current)
    setAnnotationLayoutTick((t) => t + 1)
    window.setTimeout(() => { isApplyingRef.current = false }, 50)
  }

  const removeHighlight = (id: string) => {
    isApplyingRef.current = true
    highlightElements(id).forEach((mark) => {
      const parent = mark.parentNode
      if (!parent) return
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      mark.remove()
      parent.normalize()
    })

    const nextHighlights = highlightsRef.current.filter((item) => item.id !== id)
    highlightsRef.current = nextHighlights
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })
    setEditingId((current) => current === id ? null : current)
    setAnnotationLayoutTick((t) => t + 1)
    window.setTimeout(() => { isApplyingRef.current = false }, 50)
  }



  const captureSelection = useCallback((action: 'highlight' | 'note' = 'note', color = settings.highlightColor, shape?: Highlight['shape']): boolean => {
    const selection = window.getSelection()
    let text = ''
    let prefix = ''
    let suffix = ''
    let start = 0
    let end = 0

    // Step 1: Read selection text and character offsets FIRST while selection range is completely intact
    if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim()) {
      const range = selection.getRangeAt(0)
      const currentNodes = pageTextNodes()
      const currentPageText = currentNodes.map((node) => node.textContent ?? '').join('')
      start = pageTextOffset(currentNodes, range.startContainer, range.startOffset)
      end = pageTextOffset(currentNodes, range.endContainer, range.endOffset)
      const selectedText = currentPageText.slice(start, end)
      text = selectedText.trim()
      if (text) {
        start += selectedText.length - selectedText.trimStart().length
        end = start + text.length
        prefix = currentPageText.slice(Math.max(0, start - 80), start)
        suffix = currentPageText.slice(end, Math.min(currentPageText.length, end + 80))
      }
    }

    if (!text && action === 'note') {
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
      if (action !== 'highlight') createNote()
      return false
    }

    // Step 2: Now that start/end are safely captured, unwrap any conflicting/overlapping highlights
    const overlappingMarks = new Set<string>()
    highlightElements().forEach((m) => {
      try {
        if (selection && selection.rangeCount > 0 && selection.getRangeAt(0)?.intersectsNode(m) && m.dataset.devnotesHighlight) {
          overlappingMarks.add(m.dataset.devnotesHighlight)
        }
      } catch {
        // ignore
      }
    })
    for (const h of highlights) {
      if (h.text && (h.text === text || text.includes(h.text) || h.text.includes(text))) {
        overlappingMarks.add(h.id)
      }
    }

    let inheritedNoteId: string | undefined
    if (overlappingMarks.size > 0) {
      overlappingMarks.forEach((id) => {
        const found = highlights.find((h) => h.id === id)
        if (found?.noteId && !inheritedNoteId) {
          inheritedNoteId = found.noteId
        }
        highlightElements(id).forEach((mark) => {
          const parent = mark.parentNode
          if (parent) {
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
            mark.remove()
            parent.normalize()
          }
        })
      })
    }

    // Step 3: Get clean text nodes and wrap the new mark
    const nodes = pageTextNodes()

    let attachedNoteId = inheritedNoteId
    if (action === 'note' && !attachedNoteId) {
      const now = Date.now()
      const newNote: Note = {
        id: crypto.randomUUID(),
        title: '',
        body: '',
        category: 'general',
        tags: [],
        collectionIds: [],
        pinned: false,
        favorite: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      persist({ ...pages, [pageUrl]: [newNote, ...(pages[pageUrl] ?? [])] })
      attachedNoteId = newNote.id
    }

    const highlightColor = color || settings.highlightColor || '#fef08a'
    const highlightShape = shape ?? settings.highlightStyle ?? 'marker'

    const item: Highlight = {
      id: crypto.randomUUID(),
      noteId: attachedNoteId,
      text,
      prefix,
      suffix,
      color: highlightColor,
      createdAt: Date.now(),
      shape: highlightShape,
      display: 'inline',
      placement: { side: 'right', dx: 24, dy: 0 },
      status: 'attached',
    }

    wrapTextOffsets(nodes, start, end, item.id, item.color, item.shape)
    setOrphanedHighlights((items) => items.filter((id) => id !== item.id))
    const nextHighlights = [...highlights.filter((h) => !overlappingMarks.has(h.id)), item]
    setHighlights(nextHighlights)
    void readHighlights().then((saved) => {
      saved[pageUrl] = nextHighlights
      return writeHighlights(saved)
    })

    if (action === 'note') {
      setEditingId(item.id)
    }
    setAnnotationLayoutTick((t) => t + 1)
    return true
  }, [createNote, highlights, pageUrl, pages, persist, settings.highlightColor, settings.highlightStyle])
  useEffect(() => { captureSelectionRef.current = captureSelection }, [captureSelection])

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
      if (!note && editingId !== item.id) continue

      const anchorCenterY = rect.top + rect.height / 2
      const rightSpace = visibleRight + scrollX - columnRight
      const leftSpace = columnLeft - (visibleLeft + scrollX)

      // If user manually placed the note anywhere on the page:
      if (item.placement?.manual && typeof item.placement.dx === 'number' && typeof item.placement.dy === 'number') {
        const x = Math.max(12, Math.min(pageWidth - 270, rect.left + item.placement.dx))
        const y = Math.max(12, rect.top + item.placement.dy)
        const side = item.placement.side === 'left' ? 'left' : 'right'
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

      // Natural placement: place on right gutter if room, else left gutter, else right below the text
      const canFitRight = rightSpace >= 250
      const canFitLeft = leftSpace >= 250

      let x = columnRight + 12
      let y = Math.max(anchorCenterY - 20, rightLastBottom + 10)
      let side: 'left' | 'right' = 'right'

      if (canFitRight) {
        side = 'right'
        x = columnRight + 12
        y = Math.max(anchorCenterY - 20, rightLastBottom + 10)
        rightLastBottom = y + 140
      } else if (canFitLeft) {
        side = 'left'
        x = Math.max(12, columnLeft - 250)
        y = Math.max(anchorCenterY - 20, leftLastBottom + 10)
        leftLastBottom = y + 140
      } else {
        side = 'right'
        x = Math.max(12, Math.min(pageWidth - 265, rect.left))
        y = rect.bottom + 8
      }

      placements.push({
        item,
        index,
        side,
        x,
        y,
        anchorX: rect.left + Math.min(rect.width / 2, 40),
        anchorY: rect.bottom,
        rect,
        note,
      })
    }

    return placements
  }, [allNotes, annotationLayoutTick, editingId, highlights, open, settings.panelSide, settings.panelWidth])

  const copyUnsavedText = async () => {
    const value = selected
      ? `${selected.title ? `${selected.title}\n\n` : ''}${selected.body}`
      : Object.entries(pages).flatMap(([url, items]) => items.map((note) => `${note.title || 'Untitled note'}\n${url}\n\n${note.body}`)).join('\n\n---\n\n')
    try {
      await navigator.clipboard.writeText(value || 'No note text is currently in memory.')
      setStatusMessage('Copied the current in-memory notes.')
    } catch {
      setStatusMessage('Clipboard access is unavailable. Select and copy the note text manually.')
    }
  }

  const exportPageWithNotesPdf = () => {
    document.getElementById('devnotes-print-container')?.remove()
    document.querySelectorAll('.dn-print-inline-note').forEach((el) => el.remove())

    const container = document.createElement('div')
    container.id = 'devnotes-print-container'

    const pageNotes = notes
    const pageHighlights = highlights

    const escapeHtml = (str: string) =>
      str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const categoryColors: Record<string, string> = {
      general: '#64748b',
      todo: '#10b981',
      idea: '#f59e0b',
      remember: '#6366f1',
      question: '#ec4899',
    }

    const renderNoteCardHtml = (note: Note, associatedHighlight?: Highlight) => {
      const cleanBody = cleanNoteBody(note.body)
      const lines = cleanBody.split('\n').filter(Boolean)
      const categoryLabel = note.category === 'todo' ? 'To-do' : note.category === 'idea' ? 'Idea' : note.category === 'remember' ? 'Remember' : note.category === 'question' ? 'Question' : 'Note'
      const catColor = categoryColors[note.category || 'general'] || '#64748b'
      const highlightColor = associatedHighlight?.color || catColor

      const bodyHtml = lines.map((line) => {
        const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/)
        if (taskMatch || note.category === 'todo') {
          const done = taskMatch ? taskMatch[1] !== ' ' : false
          const text = taskMatch ? taskMatch[2] : line.replace(/^\s*[-*+]\s+/, '')
          return `<span style="display:flex; align-items:center; gap:6px; margin:3px 0; font-size:12px; color:${done ? '#64748b; text-decoration:line-through;' : '#1e293b;'}">
                    <span>${done ? '☑' : '☐'}</span>
                    <span>${escapeHtml(text)}</span>
                  </span>`
        }
        return `<span style="display:block; margin:0 0 4px; font-size:12px; line-height:1.5; color:#1e293b;">${escapeHtml(line)}</span>`
      }).join('')

      const tagsHtml = note.tags && note.tags.length > 0
        ? `<span style="display:flex; gap:4px; margin-top:6px; flex-wrap:wrap;">
             ${note.tags.map((t) => `<span style="font-size:9.5px; padding:1px 6px; border:1px solid #cbd5e1; border-radius:3px; background:#ffffff; color:#64748b; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">#${escapeHtml(t)}</span>`).join('')}
           </span>`
        : ''

      return {
        catColor,
        highlightColor,
        categoryLabel,
        html: `
          <span style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">
            <span style="font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; padding:2px 7px; border-radius:3px; background:${catColor}; color:#ffffff; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">${categoryLabel}</span>
            ${note.title ? `<strong style="font-size:12.5px; color:#0f172a;">${escapeHtml(note.title)}</strong>` : ''}
          </span>
          ${bodyHtml}
          ${tagsHtml}
        `,
      }
    }

    // Insert notes referenced right at their highlighted text in the document
    const inlineElements: HTMLElement[] = []
    const inlinePlacedNoteIds = new Set<string>()

    for (const note of pageNotes) {
      const associatedHighlight = pageHighlights.find((h) => h.noteId === note.id || h.id === note.id)
      if (associatedHighlight) {
        const marks = Array.from(document.querySelectorAll<HTMLElement>(`mark[data-devnotes-highlight="${associatedHighlight.id}"]`))
        if (marks.length > 0) {
          const anchorMark = marks[marks.length - 1]
          const { highlightColor, html } = renderNoteCardHtml(note, associatedHighlight)

          const inlineNote = document.createElement('span')
          inlineNote.className = 'dn-print-inline-note'
          inlineNote.style.cssText = `display:block; margin:8px 0 12px; padding:10px 14px; border:1px solid #cbd5e1; border-left:4px solid ${highlightColor}; border-radius:6px; background:#f8fafc; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size:12px; line-height:1.5; color:#0f172a; page-break-inside:avoid; break-inside:avoid; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; clear:both; text-align:left; font-weight:normal;`
          inlineNote.innerHTML = html

          anchorMark.insertAdjacentElement('afterend', inlineNote)
          inlineElements.push(inlineNote)
          inlinePlacedNoteIds.add(note.id)
        }
      }
    }

    // Any general notes not attached to a specific highlighted text
    const unattachedNotes = pageNotes.filter((n) => !inlinePlacedNoteIds.has(n.id))
    if (unattachedNotes.length > 0) {
      const unattachedHtml = unattachedNotes.map((note) => {
        const { highlightColor, html } = renderNoteCardHtml(note)
        return `
          <article style="border:1px solid #cbd5e1; border-left:4px solid ${highlightColor}; border-radius:6px; padding:12px 14px; margin-bottom:12px; background:#f8fafc; page-break-inside:avoid; break-inside:avoid; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">
            ${html}
          </article>
        `
      }).join('')

      const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

      container.innerHTML = `
        <div style="break-before:page; page-break-before:always; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#0f172a; padding:32px 16px; max-width:800px; margin:0 auto; -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important;">
          <header style="border-bottom:2px solid #0f172a; padding-bottom:12px; margin-bottom:20px;">
            <h2 style="font-size:18px; font-weight:700; margin:0 0 6px; color:#0f172a;">Iris · Page Notes</h2>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 16px; font-size:11px; color:#475569;">
              <div><strong>Page:</strong> ${escapeHtml(document.title || hostname)}</div>
              <div><strong>URL:</strong> ${escapeHtml(pageUrl)}</div>
              <div><strong>Exported:</strong> ${dateStr}</div>
              <div><strong>General notes:</strong> ${unattachedNotes.length}</div>
            </div>
          </header>
          <section>
            ${unattachedHtml}
          </section>
        </div>
      `
      document.body.appendChild(container)
    }

    let style = document.getElementById('devnotes-print-style') as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = 'devnotes-print-style'
      document.head.appendChild(style)
    }
    style.textContent = `
      @media screen {
        .dn-print-inline-note { display: none !important; }
        #devnotes-print-container { display: none !important; }
      }
      @media print {
        #devnotes-root {
          display: none !important;
        }

        .dn-print-inline-note,
        .dn-print-inline-note *,
        mark[data-devnotes-highlight],
        mark[data-devnotes-highlight] * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        .dn-print-inline-note {
          display: block !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        html, body {
          overflow: visible !important;
          height: auto !important;
          min-height: 100% !important;
          background: #ffffff !important;
        }

        ins.adsbygoogle,
        .adsbygoogle,
        [id*="google_ads_"],
        [class*="cookie-banner"],
        [class*="consent-banner"] {
          display: none !important;
        }

        #devnotes-print-container {
          display: block !important;
          break-before: page !important;
          page-break-before: always !important;
          width: 100% !important;
          max-width: 800px !important;
          margin: 0 auto !important;
        }

        mark[data-devnotes-highlight] {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color: inherit !important;
        }
      }
    `

    const cleanup = () => {
      inlineElements.forEach((el) => el.remove())
      container.remove()
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)

    window.print()
    setTimeout(cleanup, 6000)
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
              const ids = selectionToolbar.highlightIds
              if (ids && ids.length > 0) {
                ids.forEach((id) => changeHighlightColor(id, color))
              } else {
                captureSelection('highlight', color)
              }
              window.getSelection()?.removeAllRanges()
              setSelectionToolbar(null)
            }}
          />
        ))}
        <span className="dn-toolbar-divider" />
        {(['marker', 'underline'] as const).map((shape) => (
          <button
            key={shape}
            type="button"
            className="dn-toolbar-shape-btn"
            title={`${shape === 'marker' ? 'Highlight fill' : 'Underline'} style`}
            aria-label={`${shape === 'marker' ? 'Highlight fill' : 'Underline'} style`}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const ids = selectionToolbar.highlightIds
              if (ids && ids.length > 0) {
                ids.forEach((id) => changeHighlightShape(id, shape))
              } else {
                captureSelection('highlight', undefined, shape)
              }
              window.getSelection()?.removeAllRanges()
              setSelectionToolbar(null)
            }}
          >
            {shape === 'marker' ? 'Fill' : 'Underline'}
          </button>
        ))}
        <span className="dn-toolbar-divider" />
        <button
          type="button"
          className="dn-toolbar-note-btn"
          title="Highlight and add note"
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
              const targetHighlight = highlights.find((h) => h.id === activeId)
              if (targetHighlight && !targetHighlight.noteId) {
                const now = Date.now()
                const newNote: Note = { id: crypto.randomUUID(), title: '', body: '', category: 'general', tags: [], collectionIds: [], pinned: false, favorite: false, archived: false, createdAt: now, updatedAt: now }
                persist({ ...pages, [pageUrl]: [newNote, ...(pages[pageUrl] ?? [])] })
                const nextHighlights = highlights.map((h) => h.id === activeId ? { ...h, noteId: newNote.id } : h)
                setHighlights(nextHighlights)
                void readHighlights().then((saved) => {
                  saved[pageUrl] = nextHighlights
                  return writeHighlights(saved)
                })
              }
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
              Remove
            </button>
          </>
        )}
      </div>
    )}

    {/* In-page annotations layer: anchored in document space, moves naturally with document scrolling */}
    <div className="dn-page-layer" style={{ display: hidePageAnnotations ? 'none' : undefined }}>
      {/* Dotted connectors: absolute in page space, full document height */}
      <svg
        className="dn-annotation-connectors"
        aria-hidden="true"
        style={{ height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight) }}
      >
        {annotationPlacements.filter(({ item, note }) => (note || editingId === item.id)).map(({ item, anchorX, anchorY, x, y }) => {
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
      {annotationPlacements.filter(({ item, note }) => (note || editingId === item.id)).map(({ item, x, y, note }) => (
        <AnnotationCard
          key={item.id}
          item={item}
          x={x}
          y={y}
          title={note?.title}
          body={cleanNoteBody(note?.body ?? '')}
          category={note?.category}
          editing={editingId === item.id}
          themeMode={effectiveTheme}
          onChange={(text) => setAnnotationText(item, text)}
          onCategoryChange={(cat) => setAnnotationCategory(item, cat)}
          onEditingChange={(on) => setEditing(item.id, on)}
          onToggleTask={(index, done) => { if (note) toggleInlineTask(note.id, index, done) }}
          onOpen={() => openAnnotationNote(item)}
          onRemove={() => deleteAnnotationCard(item.id)}
          onMove={(newX, newY) => moveNote(item.id, newX, newY)}
        />
      ))}
    </div>

    {!open && !settings.hideLauncher && (
      <button
        className={`dn-launcher ${settings.launcherPosition === 'bottom-left' ? 'dn-launcher-left' : ''} ${effectiveTheme === 'dark' ? 'dn-dark' : effectiveTheme === 'sepia' ? 'dn-theme-sepia' : ''}`}
        onClick={() => setOpen(true)}
        aria-label="Open Iris"
        title="Iris"
      >
        <span className="dn-mark">i<span>.</span></span>
      </button>
    )}

    <aside className={`dn-panel dn-theme-${effectiveTheme} ${libraryOpen ? 'dn-library-open' : 'dn-page-view'} ${open ? 'is-open' : ''} ${settings.panelSide === 'left' ? 'dn-panel-left' : ''} ${darkTheme ? 'dn-dark' : ''}`} style={{ width: `min(${settings.panelWidth}px, 100vw)`, left: settings.panelSide === 'left' ? 0 : 'auto', right: settings.panelSide === 'right' ? 0 : 'auto', '--dn-text-scale': settings.textSize === 'small' ? 0.92 : settings.textSize === 'large' ? 1.15 : 1 } as CSSProperties} aria-label="Iris panel" aria-hidden={!open}>
      <div
        className="dn-panel-resize-handle"
        onPointerDown={(event) => {
          event.preventDefault()
          const startX = event.clientX
          const startWidth = settings.panelWidth
          const onPointerMove = (e: PointerEvent) => {
            const delta = settings.panelSide === 'left' ? e.clientX - startX : startX - e.clientX
            const newWidth = Math.min(840, Math.max(320, Math.round(startWidth + delta)))
            updateSettings({ panelWidth: newWidth })
          }
          const onPointerUp = () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
          }
          window.addEventListener('pointermove', onPointerMove)
          window.addEventListener('pointerup', onPointerUp)
          window.addEventListener('pointercancel', onPointerUp)
        }}
        title="Drag to resize panel width"
      />
      <header className="dn-header">
        <div className="dn-brand"><span className="dn-brand-icon">i<span>.</span></span><span className="dn-brand-text">iris</span></div>
        <div className="dn-header-actions">
          <button
            type="button"
            className={`dn-header-btn ${hidePageAnnotations ? 'active' : ''}`}
            onClick={() => setHidePageAnnotations((v) => !v)}
            title={hidePageAnnotations ? "Show notes and highlights on page" : "Hide all notes and highlights on page"}
          >
            {hidePageAnnotations ? 'Show' : 'Hide'}
          </button>
          <button className="dn-header-btn" onClick={exportPageWithNotesPdf} title="Export webpage with notes to PDF">Save PDF</button>
          <button className="dn-library-toggle" onClick={() => { const next = !libraryOpen; setLibraryOpen(next); setShowAllNotes(next); if (!next) { setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) } }}>{libraryOpen ? 'This page' : 'Library'}</button>
          <button className="dn-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open Iris settings" title="Settings">⚙</button>
          <button className="dn-icon-button" onClick={() => setOpen(false)} aria-label="Close panel">×</button>
        </div>
      </header>

      {(runtimeInvalid || saveState === 'error') && <div className="dn-recovery-banner" role="alert"><span>{runtimeInvalid ? 'Iris was updated, reload this tab.' : 'Iris could not save. Your text is still in memory.'}</span><button onClick={() => void copyUnsavedText()}>Copy notes</button></div>}
      {incognitoMode && <div className="dn-privacy-banner" role="status">Incognito mode: notes stay in memory for this tab.</div>}

      {settingsOpen && (
        <section className="dn-settings" role="dialog" aria-label="Iris settings">
          <div className="dn-settings-heading">
            <div>
              <strong>Settings</strong>
              <span>Preferences are stored on this device.</span>
            </div>
            <button className="dn-icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
          </div>
          <div className="dn-settings-content">
            <label>
              Theme
              <select value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as DevNotesSettings['theme'] })}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="sepia">Sepia</option>
              </select>
            </label>
            <label>
              Selection toolbar
              <select value={settings.toolbarBehavior} onChange={(event) => updateSettings({ toolbarBehavior: event.target.value as DevNotesSettings["toolbarBehavior"] })}>
                <option value="always">Always</option>
                <option value="hold-alt">Hold Alt</option>
                <option value="never">Never</option>
              </select>
            </label>
            <label>
              Text size
              <select value={settings.textSize} onChange={(event) => updateSettings({ textSize: event.target.value as DevNotesSettings["textSize"] })}>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label>
              Panel side
              <select value={settings.panelSide} onChange={(event) => updateSettings({ panelSide: event.target.value as DevNotesSettings['panelSide'] })}>
                <option value="right">Right</option>
                <option value="left">Left</option>
              </select>
            </label>
            <label>
              Panel width <span>{settings.panelWidth}px</span>
              <input type="range" min="360" max="720" step="10" value={settings.panelWidth} onChange={(event) => updateSettings({ panelWidth: Number(event.target.value) })} />
            </label>
            <label>
              Launcher position
              <select value={settings.launcherPosition} onChange={(event) => updateSettings({ launcherPosition: event.target.value as DevNotesSettings['launcherPosition'] })}>
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
              </select>
            </label>
            <label className="dn-settings-check">
              <input type="checkbox" checked={settings.hideLauncher} onChange={(event) => updateSettings({ hideLauncher: event.target.checked })} />
              <span>Hide the floating launcher</span>
            </label>
            <div className="dn-settings-row">
              <span>Default highlight color</span>
              <div className="dn-setting-colors">
                {HIGHLIGHT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={settings.highlightColor === color ? 'selected' : ''}
                    style={{ background: color }}
                    aria-label={`Use highlight color ${color}`}
                    onClick={() => updateSettings({ highlightColor: color })}
                  />
                ))}
              </div>
            </div>
            <label>
              Trash retention <span>{settings.trashRetentionDays} days</span>
              <input type="range" min="30" max="3650" step="30" value={settings.trashRetentionDays} onChange={(event) => updateSettings({ trashRetentionDays: Number(event.target.value) })} />
            </label>
            <label>
              Version history <span>{settings.historyDepth} versions</span>
              <input type="range" min="1" max="100" value={settings.historyDepth} onChange={(event) => updateSettings({ historyDepth: Number(event.target.value) })} />
            </label>
            <div className="dn-site-settings">
              <strong>This site · {hostname}</strong>
              <button onClick={() => void disableOnThisSite()}>Disable Iris on this site</button>
            </div>
            <form className="dn-blocklist-add" onSubmit={(event) => { event.preventDefault(); addBlockedHost(blocklistDraft); setBlocklistDraft('') }}>
              <label htmlFor="dn-block-host">Block another site</label>
              <div className="dn-blocklist-add-row">
                <input type="text" id="dn-block-host" value={blocklistDraft} onChange={(event) => setBlocklistDraft(event.target.value)} placeholder="example.com" />
                <button type="submit">Add</button>
              </div>
            </form>
            <div className="dn-blocklist">
              <strong className="dn-blocklist-section-title">Blocked sites</strong>
              {settings.disabledHosts.length ? (
                settings.disabledHosts.map((host) => (
                  <div key={host} className="dn-blocklist-item">
                    <span>{host}</span>
                    <button aria-label={`Unblock ${host}`} onClick={() => allowHost(host)}>Allow</button>
                  </div>
                ))
              ) : (
                <small className="dn-blocklist-empty">No custom sites blocked.</small>
              )}
              <strong className="dn-blocklist-section-title">Default protected sites</strong>
              {DEFAULT_BLOCKED_HOSTS.map((host) => {
                const allowed = settings.enabledHosts.some((rule) => hostMatches(hostname, rule)) && hostMatches(hostname, host)
                return (
                  <div key={host} className="dn-blocklist-item">
                    <span>{host}</span>
                    <button aria-label={`${allowed ? 'Block' : 'Allow'} Iris on ${host}`} onClick={() => allowed ? addBlockedHost(host) : allowHost(host)}>
                      {allowed ? 'Block' : 'Allow'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      <div className="dn-category-tabs">
        {([
          ['all', 'All'],
          ['general', 'Note'],
          ['todo', 'To-do'],
          ['idea', 'Idea'],
          ['remember', 'Remember'],
          ['question', 'Question'],
        ] as const).map(([cat, label]) => (
          <button
            key={cat}
            type="button"
            className={`dn-category-tab ${categoryFilter === cat ? 'active' : ''}`}
            onClick={() => setCategoryFilter(cat)}
          >
            {cat !== 'all' && <span className={`dn-cat-dot dn-cat-${cat}`} />}
            {label}
          </button>
        ))}
      </div>

      <div className="dn-dashboard-tabs">
        <button className={!showAllNotes && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(false); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false); setCollectionFilter('') }}>This page</button>
        <button className={showAllNotes && !showArchived && !showFavorites && !showTasks && !showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>All notes</button>
        <button className={showTasks ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(false); setShowTasks(true); setShowTrash(false) }}>Tasks</button>
        <button className={showFavorites ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(false); setShowFavorites(true); setShowTasks(false); setShowTrash(false) }}>Favorites</button>
        <button className={showArchived ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowArchived(true); setShowFavorites(false); setShowTasks(false); setShowTrash(false) }}>Archived</button>
        <button className={showTrash ? 'active' : ''} onClick={() => { setShowAllNotes(true); setShowTrash(true); setShowArchived(false); setShowFavorites(false); setShowTasks(false) }}>Trash</button>
      </div>
      <div className="dn-page-heading">
        <h1>{showTrash ? 'Trash' : showArchived ? 'Archived' : showTasks ? 'Tasks' : showFavorites ? 'Favorites' : showAllNotes ? 'All notes' : 'Page notes'} <span>{showTrash ? trash.length : showArchived ? allNotes.filter(({ note }) => note.archived).length : showTasks ? allNotes.filter(({ note }) => !note.archived && (/(?:^|\n)\s*[-*+]\s*\[([ xX])\]/.test(note.body) || note.category === 'todo')).length : showFavorites ? allNotes.filter(({ note }) => note.favorite && !note.archived).length : showAllNotes ? allNotes.filter(({ note }) => !note.archived).length : notes.filter((note) => !note.archived).length}</span></h1>
        <div className="dn-heading-actions">
          <button className="dn-new" onClick={() => createNote()}>+ New note</button>
        </div>
      </div>
      {showAllNotes && <div className="dn-collection-bar"><select aria-label="Filter by collection" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">All collections</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select><input className="dn-domain-filter" aria-label="Filter by website domain" placeholder="Domain" value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} /><select aria-label="Sort notes" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}><option value="updated">Updated</option><option value="created">Created</option><option value="title">Title</option></select><button className="dn-collection-add" onClick={createCollection} title="Add collection">＋</button></div>}
      {showAllNotes && availableTags.length > 0 && (
        <div className="dn-tag-browser">
          <span className="dn-tag-browser-label">Tags</span>
          <div className="dn-tag-browser-list">
            {availableTags.map((tag) => {
              const active = isTagInQuery(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className={`dn-tag-chip ${active ? 'active' : ''}`}
                  onClick={() => toggleTagInQuery(tag)}
                  title={active ? `Remove tag filter ${tag}` : `Filter by tag ${tag}`}
                >
                  #{tag}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {showAllNotes && bulkSelection.length > 0 && (
        <div className="dn-bulk-actions">
          <span className="dn-bulk-count">
            <strong>{bulkSelection.length}</strong> selected
          </span>
          <div className="dn-bulk-buttons">
            <button type="button" className="dn-bulk-btn" onClick={() => { setBulkTagEditing(true); setBulkCollectionEditing(false) }}>Add tags</button>
            <button type="button" className="dn-bulk-btn" onClick={() => { setBulkCollectionEditing(true); setBulkTagEditing(false) }}>Add to collection</button>
            <button type="button" className="dn-bulk-btn" onClick={() => bulkUpdate((note) => ({ ...note, archived: true }))}>Archive</button>
            <button type="button" className="dn-bulk-btn dn-bulk-btn-clear" onClick={() => { setBulkSelection([]); setBulkTagEditing(false); setBulkCollectionEditing(false) }}>Clear</button>
          </div>
        </div>
      )}
      {bulkTagEditing && (
        <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); applyBulkTags() }}>
          <input autoFocus aria-label="Tags to add" placeholder="Tags, separated by commas" value={bulkTagDraft} onChange={(event) => setBulkTagDraft(event.target.value)} />
          <button type="submit">Apply</button>
          <button type="button" onClick={() => { setBulkTagEditing(false); setBulkTagDraft('') }}>Cancel</button>
        </form>
      )}
      {bulkCollectionEditing && (
        <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); applyBulkCollection() }}>
          {collections.length > 0 && (
            <select
              autoFocus
              aria-label="Select collection"
              value={bulkCollectionTarget}
              onChange={(event) => setBulkCollectionTarget(event.target.value)}
            >
              <option value="">Select collection...</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value="__new__">+ New collection...</option>
            </select>
          )}
          {(collections.length === 0 || bulkCollectionTarget === '__new__') && (
            <input
              autoFocus={collections.length === 0}
              aria-label="Collection name"
              placeholder="Collection name..."
              value={bulkNewCollectionName}
              onChange={(event) => setBulkNewCollectionName(event.target.value)}
            />
          )}
          <button
            type="submit"
            disabled={
              collections.length > 0 && bulkCollectionTarget !== '__new__'
                ? !bulkCollectionTarget
                : !bulkNewCollectionName.trim()
            }
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setBulkCollectionEditing(false)
              setBulkCollectionTarget('')
              setBulkNewCollectionName('')
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {addingCollection && <form className="dn-new-collection" onSubmit={(event) => { event.preventDefault(); saveCollection() }}><input autoFocus aria-label="Collection name" placeholder="Collection name..." value={collectionDraft} onChange={(event) => setCollectionDraft(event.target.value)} /><button type="submit">Create</button><button type="button" onClick={() => { setAddingCollection(false); setCollectionDraft('') }}>Cancel</button></form>}
      <label className="dn-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.8" /><path d="m13.2 13.2 4 4" /></svg><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setLibraryOpen(true); setShowAllNotes(true) }} placeholder="Search notes" /><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd></label>
      {statusMessage && <div className="dn-import-status" role="status">{statusMessage}<button aria-label="Dismiss message" onClick={() => setStatusMessage('')}>×</button></div>}
      {!ready ? <div className="dn-empty">Loading your notes…</div> : showTrash ? <div className="dn-trash-list">{trash.length ? trash.map((entry) => <div className="dn-trash-row" key={entry.note.id}><span><strong>{entry.note.title || 'Untitled note'}</strong><small>{safeHostname(entry.url)}</small></span><button className="dn-preview-toggle" onClick={() => restoreFromTrash(entry)}>Restore</button><button className="dn-delete" onClick={() => { const next = trash.filter((item) => item.note.id !== entry.note.id); setTrash(next); void writeTrash(next) }}>Delete forever</button></div>) : <div className="dn-empty">Trash is empty.</div>}</div> : !showAllNotes && notes.length === 0 && !query.trim() ? <div className="dn-empty-state"><strong>No notes on this page</strong><button onClick={() => createNote()}>+ New note</button></div> : filteredNotes.length === 0 ? <div className="dn-empty">{query.trim() ? `No notes match “${query}”.` : 'No notes here yet.'}</div> : <div className="dn-content">
        <div className="dn-note-list">{filteredNotes.map(({ note, url }) => {
          const noteTitle = cleanDisplayTitle(note)
          const notePreview = cleanDisplayPreview(note)
          return (
            <div key={`${url}:${note.id}`} className={`dn-note-row-wrap dn-cat-${note.category || 'general'} ${selectedPageUrl === url && selectedId === note.id ? 'active' : ''}`}>
              {showAllNotes && <input className="dn-bulk-check" type="checkbox" aria-label={`Select ${noteTitle}`} checked={bulkSelection.includes(note.id)} onChange={(event) => setBulkSelection((ids) => event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id))} />}
              <button className="dn-note-row" onClick={() => {
                if (selectedPageUrl === url && selectedId === note.id) {
                  setSelectedId(null)
                } else {
                  setSelectedPageUrl(url)
                  setSelectedId(note.id)
                }
              }}>
                <span className="dn-note-row-text">
                  <strong>{note.pinned ? <span className="dn-pinned-badge" title="Pinned note">● </span> : null}<SearchMatch text={noteTitle} query={query} /></strong>
                  <small>{showAllNotes || query ? safeHostname(url) + ' · ' : ''}{notePreview}</small>
                </span>
              </button>
              <button className="dn-row-delete-btn" title="Delete note" aria-label="Delete note" onClick={(event) => { event.stopPropagation(); deleteNote(note.id, url) }}>×</button>
            </div>
          )
        })}</div>
        {selected ? (
          <article className="dn-editor">
            <div className="dn-editor-top">
              <div className="dn-editor-category-pills">
                {(['general', 'todo', 'idea', 'remember', 'question'] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`dn-cat-pill dn-cat-${cat} ${selected.category === cat || (!selected.category && cat === 'general') ? 'active' : ''}`}
                    onClick={() => {
                      updateSelected({ category: cat })
                      if (cat === 'todo' && !selected.body.trim()) {
                        updateNote('body', '- [ ] ')
                      }
                    }}
                  >
                    <span className={`dn-cat-dot dn-cat-${cat}`} />
                    {cat === 'general' ? 'Note' : cat === 'todo' ? 'To-do' : cat === 'idea' ? 'Idea' : cat === 'remember' ? 'Remember' : 'Question'}
                  </button>
                ))}
              </div>
              <div className="dn-editor-actions">
                <button type="button" className="dn-action-btn dn-action-close" onClick={() => setSelectedId(null)} title="Close note editor">Close</button>
                <button type="button" className={`dn-action-btn ${selected.pinned ? 'active' : ''}`} onClick={() => updateSelected({ pinned: !selected.pinned })}>{selected.pinned ? 'Pinned' : 'Pin'}</button>
                <button type="button" className="dn-action-btn dn-action-delete" onClick={() => deleteNote(selected.id, selectedPageUrl)} title="Move note to trash">Delete</button>
              </div>
            </div>
            <input className="dn-title" placeholder="Title (optional)" value={selected.title} onChange={(event) => updateNote('title', event.target.value)} />
            {selected.category === 'todo' ? <TodoEditor body={selected.body} onChange={(body) => updateNote('body', body)} /> : <textarea className="dn-body" placeholder="Start writing…" value={selected.body} onChange={(event) => updateNote('body', event.target.value)} />}
            <TagInput key={selected.id} tags={selected.tags ?? []} onCommit={(tags) => updateNote('tags', tags)} />
            <div className="dn-editor-collections">
              <div className="dn-editor-collections-pills">
                {(selected.collectionIds ?? []).map((colId) => {
                  const col = collections.find((c) => c.id === colId)
                  if (!col) return null
                  return (
                    <span key={col.id} className="dn-col-pill">
                      {col.name}
                      <button
                        type="button"
                        className="dn-col-remove-btn"
                        title={`Remove from ${col.name}`}
                        aria-label={`Remove from ${col.name}`}
                        onClick={() => {
                          const next = (selected.collectionIds ?? []).filter((id) => id !== col.id)
                          updateNote('collectionIds', next)
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
              <div className="dn-col-select-row">
                <select
                  className="dn-col-select"
                  aria-label="Add note to collection"
                  value=""
                  onChange={(event) => {
                    const val = event.target.value
                    if (!val) return
                    if (val === '__new__') {
                      setAddingCollection(true)
                    } else {
                      const next = [...new Set([...(selected.collectionIds ?? []), val])]
                      updateNote('collectionIds', next)
                    }
                  }}
                >
                  <option value="">+ Add to collection...</option>
                  {collections
                    .filter((c) => !(selected.collectionIds ?? []).includes(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  <option value="__new__">+ Create new collection...</option>
                </select>
              </div>
            </div>
            {saveState === 'error' && <div className="dn-editor-error">Save failed · try editing again</div>}
          </article>
        ) : null}
      </div>}
    </aside>
  </>
}

export default App
