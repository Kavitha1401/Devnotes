import { createRoot } from 'react-dom/client'
import styles from '../App.css?inline'
import App from '../App'

function mount() {
  if (document.getElementById('devnotes-root')) return
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
  createRoot(container).render(<App />)
}

// Only inject on http/https pages
if (/^https?:/.test(location.protocol)) {
  mount()
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'DEVNOTES_TOGGLE') return
    window.dispatchEvent(new CustomEvent('devnotes-toggle'))
  })
}
