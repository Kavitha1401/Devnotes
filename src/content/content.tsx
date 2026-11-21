import { createRoot } from 'react-dom/client'
import styles from '../App.css?inline'
import App from '../App'

let appEventTarget: HTMLElement | null = null
let appRoot: ReturnType<typeof createRoot> | null = null

function mount() {
  const existing = document.getElementById('devnotes-root')
  if (existing) {
    appRoot?.unmount()
    existing.remove()
    appEventTarget = null
  }
  const host = document.createElement('div')
  host.id = 'devnotes-root'
  // Reset inherited styles from the page
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;'
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'closed' })
  const styleEl = document.createElement('style')
  styleEl.textContent = styles
  shadow.appendChild(styleEl)

  const container = document.createElement('div')
  shadow.appendChild(container)
  appEventTarget = container
  appRoot = createRoot(container)
  appRoot.render(<App messageTarget={container} />)
}

// Only inject on http/https pages
if (/^https?:/.test(location.protocol)) {
  mount()
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!appEventTarget) return
    if (message?.type === 'DEVNOTES_TOGGLE') appEventTarget.dispatchEvent(new Event('devnotes-toggle'))
    if (message?.type === 'DEVNOTES_FOCUS_SEARCH') appEventTarget.dispatchEvent(new Event('devnotes-focus-search'))
    if (message?.type === 'DEVNOTES_CAPTURE_SELECTION') appEventTarget.dispatchEvent(new Event('devnotes-capture-selection'))
    if (message?.type === 'DEVNOTES_NEW_NOTE') appEventTarget.dispatchEvent(new Event('devnotes-new-note'))
  })
}
