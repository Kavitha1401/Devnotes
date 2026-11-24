import { HIGHLIGHT_COLORS, normalizeSettings } from '../settings'
import { isRecord, migratePages, normalizePageUrl } from './core'
import type { BackupFile, Highlight, Note, NotePlacement, PageNotes, TrashEntry } from './types'

function validatePageNotes(value: unknown): PageNotes | null {
  if (!isRecord(value)) return null
  const result: PageNotes = {}
  for (const [url, rawNotes] of Object.entries(value)) {
    try { if (!/^https?:$/.test(new URL(url).protocol)) return null } catch { return null }
    if (!Array.isArray(rawNotes) || rawNotes.some((note) => !isRecord(note) || typeof note.id !== 'string' || typeof note.title !== 'string' || typeof note.body !== 'string' || typeof note.createdAt !== 'number' || typeof note.updatedAt !== 'number')) return null
    result[normalizePageUrl(url)] = rawNotes as Note[]
  }
  return migratePages<Note>(result)
}

export function validateBackup(value: unknown): BackupFile | null {
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
      normalizedHighlights[normalizedUrl] = (items as Highlight[]).filter((item) => item.text.length > 0 && item.text.length <= 5_000).map((item) => {
        const placement: NotePlacement = item.placement && typeof item.placement.dx === 'number' && typeof item.placement.dy === 'number'
          ? { side: item.placement.side === 'left' ? 'left' : 'right', dx: Math.round(item.placement.dx), dy: Math.round(item.placement.dy), manual: Boolean(item.placement.manual) }
          : { side: 'right', dx: 24, dy: 0 }
        return { ...item, color: HIGHLIGHT_COLORS.includes(item.color as typeof HIGHLIGHT_COLORS[number]) ? item.color : HIGHLIGHT_COLORS[0], shape: ['marker', 'underline', 'box', 'bracket'].includes(item.shape ?? '') ? item.shape : 'marker', display: item.display === 'sticky' ? 'sticky' : 'inline', placement, status: item.status === 'orphan' ? 'orphan' : 'attached', stickyX: undefined, stickyY: undefined }
      })
    } catch { return null }
  }
  const trash = value.trash === undefined ? [] : value.trash
  if (!Array.isArray(trash) || trash.some((item) => !isRecord(item) || typeof item.url !== 'string' || typeof item.deletedAt !== 'number' || validatePageNotes({ [item.url]: [item.note] }) === null)) return null
  const normalizedTrash = (trash as TrashEntry[]).map((item) => ({ ...item, url: normalizePageUrl(item.url) }))
  return { format: 'devnotes-backup', version: value.version, pages, collections: collections as BackupFile['collections'], highlights: normalizedHighlights, trash: normalizedTrash, settings: value.settings === undefined ? undefined : normalizeSettings(value.settings), pageMeta: isRecord(value.pageMeta) ? value.pageMeta as BackupFile['pageMeta'] : undefined }
}

