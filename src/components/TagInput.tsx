import { useState } from 'react'

export function TagInput({ tags, onCommit }: { tags: string[]; onCommit: (tags: string[]) => void }) {
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
