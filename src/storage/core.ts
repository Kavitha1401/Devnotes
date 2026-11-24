export type StoredNote = { id: string; updatedAt: number; [key: string]: unknown }
export type PageNotes = Record<string, StoredNote[]>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function migratePages<T extends { id: string; title: string; body: string; createdAt: number; updatedAt: number; tags?: string[]; collectionIds?: string[]; history?: unknown[]; pinned?: boolean; favorite?: boolean; archived?: boolean }>(value: unknown): Record<string, T[]> {
  if (!isRecord(value)) return {}
  const pages: Record<string, T[]> = {}
  for (const [url, rawNotes] of Object.entries(value)) {
    let normalizedUrl: string
    try {
      normalizedUrl = normalizePageUrl(url)
      if (!/^https?:$/.test(new URL(normalizedUrl).protocol)) continue
    } catch { continue }
    if (!Array.isArray(rawNotes)) continue
    const notes = rawNotes.filter((note): note is T => isRecord(note) && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.body === 'string' && typeof note.createdAt === 'number' && typeof note.updatedAt === 'number').map((note) => ({
      ...note,
      tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      collectionIds: Array.isArray(note.collectionIds) ? note.collectionIds.filter((id): id is string => typeof id === 'string') : [],
      history: Array.isArray(note.history) ? note.history.filter((item) => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string' && typeof item.savedAt === 'number').slice(-20) : [],
      pinned: Boolean(note.pinned),
      favorite: Boolean(note.favorite),
      archived: Boolean(note.archived),
    } as T))
    pages[normalizedUrl] = [...(pages[normalizedUrl] ?? []), ...notes]
  }
  return pages
}

export function normalizePageUrl(href: string): string {
  const url = new URL(href)
  url.hash = ''
  const trackingKeys: string[] = []
  url.searchParams.forEach((_value, key) => {
    if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid|token|access_token|refresh_token|auth|authorization|session|sessionid|sid|api_key|apikey|key|code|password|secret|jwt)$/i.test(key)) trackingKeys.push(key)
  })
  for (const key of trackingKeys) url.searchParams.delete(key)
  url.searchParams.sort()
  return url.toString().replace(/\/$/, '')
}

export function mergePages<T extends StoredNote>(current: Record<string, T[]>, incoming: Record<string, T[]>): Record<string, T[]> {
  const merged: Record<string, T[]> = { ...current }
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

export function removeDeletedPages<T extends { id: string }>(pages: Record<string, T[]>, deleted: Record<string, number>): Record<string, T[]> {
  return Object.fromEntries(Object.entries(pages).map(([url, notes]) => [url, notes.filter((note) => !deleted[note.id])]))
}

export function cleanNoteBody(body: string): string {
  const legacyLine = /^\s*(?:>\s|Source:|\u2014\s*\[|\u00e2\u20ac\u201d\s*\[)/i
  return body.split('\n').filter((line) => !legacyLine.test(line)).join('\n').replace(/\n{3,}/g, '\n\n')
}
