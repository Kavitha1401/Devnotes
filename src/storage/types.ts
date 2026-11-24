import type { DevNotesSettings } from '../settings'

export type Revision = { id: string; title: string; body: string; savedAt: number }
export type Note = { id: string; title: string; body: string; tags?: string[]; collectionIds?: string[]; pinned?: boolean; favorite?: boolean; archived?: boolean; history?: Revision[]; createdAt: number; updatedAt: number }
export type PageNotes = Record<string, Note[]>
export type Collection = { id: string; name: string; createdAt: number }
export type NotePlacement = { side: 'left' | 'right' | 'inline'; dx: number; dy: number; manual?: boolean }
export type Highlight = { id: string; noteId?: string; text: string; prefix: string; suffix: string; color: string; createdAt: number; shape?: 'marker' | 'underline' | 'box' | 'bracket' | 'none'; display?: 'inline' | 'sticky'; placement?: NotePlacement; status?: 'attached' | 'orphan'; stickyX?: number; stickyY?: number }
export type PageTask = { id: string; text: string; done: boolean }
export type PageMeta = { status: 'to-read' | 'reading' | 'done'; whySaved: string; tasks: PageTask[]; journalEntry: string; journalEntries?: Record<string, string>; updatedAt: number }
export type TrashEntry = { note: Note; url: string; deletedAt: number }
export type BackupFile = { format: 'devnotes-backup'; version: number; pages: PageNotes; collections: Collection[]; highlights: Record<string, Highlight[]>; trash: TrashEntry[]; settings?: DevNotesSettings; pageMeta?: Record<string, PageMeta> }
