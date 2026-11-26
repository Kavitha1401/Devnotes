import { useState } from 'react'

export function TagInput({ tags, onCommit }: { tags: string[]; onCommit: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')

  const commitDraft = () => {
    const additions = draft.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
    if (!additions.length) return
    const next = [...new Set([...tags, ...additions])]
    onCommit(next)
    setDraft('')
  }

  const removeTag = (tagToRemove: string) => {
    onCommit(tags.filter((t) => t !== tagToRemove))
  }

  return (
    <div className="dn-tag-input-wrap">
      {tags.length > 0 && (
        <div className="dn-tag-pills">
          {tags.map((tag) => (
            <span key={tag} className="dn-tag-pill">
              #{tag}
              <button
                type="button"
                className="dn-tag-remove-btn"
                title={`Remove tag ${tag}`}
                aria-label={`Remove tag ${tag}`}
                onClick={() => removeTag(tag)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="dn-tags"
        aria-label="Note tags"
        placeholder={tags.length ? "Add more tags..." : "Add tags, separated by commas"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === ',' || event.key === 'Enter') {
            event.preventDefault()
            commitDraft()
          } else if (event.key === 'Backspace' && !draft && tags.length > 0) {
            removeTag(tags[tags.length - 1])
          }
        }}
      />
    </div>
  )
}
