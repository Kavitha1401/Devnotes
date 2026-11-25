import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Highlight, NoteCategory } from '../storage/types'

const CARD_TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/

const CATEGORY_CONFIG: Record<NoteCategory, { label: string; color: string }> = {
  general: { label: 'Note', color: '#64748b' },
  todo: { label: 'To-do', color: '#10b981' },
  idea: { label: 'Idea', color: '#f59e0b' },
  remember: { label: 'Remember', color: '#3b82f6' },
  question: { label: 'Question', color: '#ec4899' },
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.length > 4 && part.startsWith('**') && part.endsWith('**') ? <b key={index}>{part.slice(2, -2)}</b> : part)
}

function CardBody({ body, editing, onChange, onEditingChange, onToggleTask }: {
  body: string
  editing: boolean
  onChange: (text: string) => void
  onEditingChange: (editing: boolean) => void
  onToggleTask: (taskIndex: number, done: boolean) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(body)
  const [lastPropBody, setLastPropBody] = useState(body)

  if (!editing && body !== lastPropBody) {
    setLastPropBody(body)
    setDraft(body)
  }

  const reading = !editing && draft.trim().length > 0

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, reading])

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (reading) {
    const lines = draft.split('\n')
    return <div className="dn-card-read" onClick={() => onEditingChange(true)}>
      {lines.map((line, index) => {
        const task = line.match(CARD_TASK_LINE)
        if (task) {
          const current = lines.slice(0, index).filter((previous) => CARD_TASK_LINE.test(previous)).length
          const done = task[1] !== ' '
          return <label key={index} className="dn-card-task" onClick={(event) => event.stopPropagation()}>
            <input type="checkbox" checked={done} onChange={(event) => onToggleTask(current, event.target.checked)} />
            <span className={done ? 'done' : ''}>{task[2]}</span>
          </label>
        }
        return line.trim() ? <p key={index}>{renderInline(line)}</p> : null
      })}
    </div>
  }

  return <textarea
    ref={ref}
    className="dn-card-input"
    value={draft}
    rows={1}
    placeholder="Write a note..."
    aria-label="Annotation note"
    onChange={(event) => {
      const val = event.target.value
      setDraft(val)
      onChange(val)
    }}
    onFocus={() => onEditingChange(true)}
    onBlur={() => {
      onEditingChange(false)
      onChange(draft)
    }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') event.currentTarget.blur()
    }}
    onKeyUp={(event) => event.stopPropagation()}
    onKeyPress={(event) => event.stopPropagation()}
  />
}

export function AnnotationCard({
  item: _item,
  x,
  y,
  body,
  category = 'general',
  editing,
  noteFont = 'sans',
  onChange,
  onCategoryChange,
  onFontChange,
  onEditingChange,
  onToggleTask,
  onOpen,
  onRemove,
  onMove,
  themeMode,
}: {
  item: Highlight
  x: number
  y: number
  body: string
  category?: NoteCategory
  editing: boolean
  penSet?: string
  noteFont?: string
  onChange: (text: string) => void
  onCategoryChange?: (category: NoteCategory) => void
  onFontChange?: (font: 'sans' | 'serif' | 'mono') => void
  onEditingChange: (editing: boolean) => void
  onToggleTask: (taskIndex: number, done: boolean) => void
  onOpen: () => void
  onRemove: () => void
  onMove?: (pageX: number, pageY: number) => void
  themeMode: 'light' | 'dark' | 'sepia'
}) {
  const dragOffset = useRef<{ x: number; y: number } | null>(null)
  const isDragging = useRef(false)
  const currentCategory = category || 'general'
  const config = CATEGORY_CONFIG[currentCategory]

  const cycleCategory = () => {
    const list: NoteCategory[] = ['general', 'todo', 'idea', 'remember', 'question']
    const next = list[(list.indexOf(currentCategory) + 1) % list.length]
    onCategoryChange?.(next)
  }

  const style = {
    left: x,
    top: y,
    '--card-cat-color': config.color,
  } as CSSProperties

  return <section
    className={`dn-card dn-font-${noteFont} ${themeMode === 'dark' ? 'dn-dark' : themeMode === 'sepia' ? 'dn-theme-sepia' : ''}`}
    style={style}
    aria-label="Note"
  >
    <div
      className="dn-card-header"
      role="presentation"
      title="Drag to place anywhere"
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button, input, textarea')) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragOffset.current = { x: event.pageX - x, y: event.pageY - y }
        isDragging.current = true
      }}
      onPointerMove={(event) => {
        if (isDragging.current && dragOffset.current) {
          onMove?.(Math.max(8, event.pageX - dragOffset.current.x), Math.max(8, event.pageY - dragOffset.current.y))
        }
      }}
      onPointerUp={(event) => {
        if (isDragging.current) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
          dragOffset.current = null
          isDragging.current = false
        }
      }}
      onPointerCancel={(event) => {
        if (isDragging.current) {
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
          dragOffset.current = null
          isDragging.current = false
        }
      }}
    >
      <button
        type="button"
        className="dn-card-badge-btn"
        title="Click to switch category: Note, To-do, Idea, Remember, Question"
        onClick={(event) => {
          event.stopPropagation()
          cycleCategory()
        }}
      >
        <span className="dn-card-badge-dot" style={{ backgroundColor: config.color }} />
        <span>{config.label}</span>
      </button>
      <div className="dn-card-header-right">
        {onFontChange && (
          <button
            type="button"
            className="dn-card-font-btn"
            title={`Font: ${noteFont}. Click to change.`}
            onClick={(event) => {
              event.stopPropagation()
              const fonts: ('sans' | 'serif' | 'mono')[] = ['sans', 'serif', 'mono']
              const next = fonts[(fonts.indexOf(noteFont as any) + 1) % fonts.length]
              onFontChange(next)
            }}
          >
            Aa
          </button>
        )}
        <button
          type="button"
          className="dn-card-open-btn"
          title="Open note in side panel"
          aria-label="Open note in side panel"
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          ↗
        </button>
        <span className="dn-card-drag-hint" title="Drag to move note">⋮⋮</span>
        <button
          type="button"
          className="dn-card-delete-icon"
          title="Delete this note"
          aria-label="Delete this note"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          ✕
        </button>
      </div>
    </div>
    <CardBody body={body} editing={editing} onChange={onChange} onEditingChange={onEditingChange} onToggleTask={onToggleTask} />
  </section>
}
