import { useMemo, useState } from 'react'

export function TodoEditor({
  body,
  onChange,
}: {
  body: string
  onChange: (body: string) => void
}) {
  const [rawMode, setRawMode] = useState(false)
  const [newTaskText, setNewTaskText] = useState('')

  const tasks = useMemo(() => {
    const lines = body.split('\n')
    const list: { done: boolean; text: string }[] = []
    for (const line of lines) {
      const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/)
      if (match) {
        list.push({ done: match[1] !== ' ', text: match[2] })
      } else if (line.trim()) {
        list.push({ done: false, text: line.replace(/^\s*[-*+]\s+/, '') })
      }
    }
    return list
  }, [body])

  const updateTask = (itemIndex: number, newDone: boolean, newText: string) => {
    const updated = tasks.map((t, i) => i === itemIndex ? { ...t, done: newDone, text: newText } : t)
    onChange(updated.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'))
  }

  const deleteTask = (itemIndex: number) => {
    const updated = tasks.filter((_, i) => i !== itemIndex)
    onChange(updated.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'))
  }

  const addTask = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const updated = [...tasks, { done: false, text: trimmed }]
    onChange(updated.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'))
    setNewTaskText('')
  }

  if (rawMode) {
    return (
      <div className="dn-todo-container">
        <div className="dn-todo-header">
          <small>{tasks.filter((t) => t.done).length} of {tasks.length} done</small>
          <button type="button" className="dn-todo-mode-btn" onClick={() => setRawMode(false)}>Checklist view</button>
        </div>
        <textarea
          className="dn-body"
          placeholder="Write tasks..."
          value={body}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  return (
    <div className="dn-todo-container">
      <div className="dn-todo-header">
        <small>{tasks.filter((t) => t.done).length} of {tasks.length} done</small>
        <button type="button" className="dn-todo-mode-btn" onClick={() => setRawMode(true)}>Edit as text</button>
      </div>
      <div className="dn-todo-list">
        {tasks.map((task, i) => (
          <div key={i} className={`dn-todo-item ${task.done ? 'is-done' : ''}`}>
            <input
              type="checkbox"
              className="dn-todo-check"
              checked={task.done}
              onChange={(e) => updateTask(i, e.target.checked, task.text)}
              aria-label={`Mark "${task.text}" as ${task.done ? 'incomplete' : 'complete'}`}
            />
            <input
              type="text"
              className="dn-todo-text"
              value={task.text}
              placeholder="Task description..."
              onChange={(e) => updateTask(i, task.done, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const updated = [...tasks.slice(0, i + 1), { done: false, text: '' }, ...tasks.slice(i + 1)]
                  onChange(updated.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'))
                } else if (e.key === 'Backspace' && !task.text) {
                  e.preventDefault()
                  deleteTask(i)
                }
              }}
            />
            <button
              type="button"
              className="dn-todo-delete-btn"
              title="Delete task"
              aria-label="Delete task"
              onClick={() => deleteTask(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <form
        className="dn-todo-add-form"
        onSubmit={(e) => {
          e.preventDefault()
          addTask(newTaskText)
        }}
      >
        <span className="dn-todo-add-icon">+</span>
        <input
          type="text"
          className="dn-todo-add-input"
          placeholder="Add a new task..."
          value={newTaskText}
          onChange={(e) => setNewTaskText(e.target.value)}
        />
      </form>
    </div>
  )
}
