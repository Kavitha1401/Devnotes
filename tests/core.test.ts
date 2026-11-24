import { afterEach, describe, expect, it } from 'vitest'
import { applyHighlights } from '../src/App'
import { validateBackup } from '../src/storage/backup'
import { cleanNoteBody, mergePages, normalizePageUrl, removeDeletedPages } from '../src/storage/core'

describe('page URLs', () => {
  it('drops fragments and tracking secrets and sorts meaningful parameters', () => {
    expect(normalizePageUrl('https://example.com/read?z=2&utm_source=mail&a=1#part'))
      .toBe('https://example.com/read?a=1&z=2')
  })
})

describe('note merge and tombstones', () => {
  const older = { id: 'n1', title: 'old', body: '', createdAt: 1, updatedAt: 10 }
  const newer = { ...older, title: 'new', updatedAt: 20 }

  it('keeps the latest version by updatedAt', () => {
    const merged = mergePages({ 'https://example.com': [newer] }, { 'https://example.com': [older] })
    expect(merged['https://example.com']).toEqual([newer])
  })

  it('removes tombstoned notes from every page', () => {
    expect(removeDeletedPages({ 'https://example.com': [older] }, { n1: 15 }))
      .toEqual({ 'https://example.com': [] })
  })
})

describe('backup validation', () => {
  it('accepts valid local backup data and rejects malformed page records', () => {
    expect(validateBackup({ format: 'devnotes-backup', version: 1, pages: { 'https://example.com': [] } })).not.toBeNull()
    expect(validateBackup({ format: 'devnotes-backup', version: 1, pages: { 'javascript:alert(1)': [] } })).toBeNull()
  })
})

describe('highlight anchoring', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('restores an exact anchor and reanchors a small text edit in jsdom', () => {
    const quote = 'The quick brown fox jumps'
    const item = { id: 'h1', text: quote, prefix: 'Before ', suffix: ' over the fence', color: '#f6e58d' }
    document.body.innerHTML = '<article>Before The quick brown fox jumps over the fence</article>'
    expect(applyHighlights([item])).toEqual([])
    expect(document.querySelector('mark[data-devnotes-highlight="h1"]')?.textContent).toBe(quote)

    document.body.innerHTML = '<article>Before The quack brown fox jumps over the fence</article>'
    expect(applyHighlights([item])).toEqual([])
    expect(document.querySelector('mark[data-devnotes-highlight="h1"]')?.textContent).toBe('The quack brown fox jumps')
  })
})

describe('note body cleanup', () => {
  it('hides quoted selection and legacy source lines while keeping user text', () => {
    expect(cleanNoteBody('My thought\n> selected passage\nSource: https://example.com\n— [Open passage](https://example.com)'))
      .toBe('My thought')
  })
})
