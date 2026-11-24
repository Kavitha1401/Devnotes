import { createRoot } from 'react-dom/client'
import styles from '../App.css?inline'
import App from '../App'
import { isHostDisabled, normalizeHost, readSettings, writeSettings } from '../settings'

let appEventTarget: HTMLElement | null = null
let appRoot: ReturnType<typeof createRoot> | null = null
let mountPending = false

function mount() {
  if (appEventTarget) return
  const existing = document.getElementById('devnotes-root')
  if (existing) {
    appRoot?.unmount()
    existing.remove()
    appEventTarget = null
  }
  const host = document.createElement('div')
  host.id = 'devnotes-root'
  // Page-level layer anchored to documentElement top-left; child overlays use page-space or viewport-fixed positioning
  host.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: visible; z-index: 2147483647; pointer-events: none;'
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'closed' })
  const styleEl = document.createElement('style')
  styleEl.textContent = styles
  shadow.appendChild(styleEl)

  const container = document.createElement('div')
  shadow.appendChild(container)
  container.addEventListener('devnotes-disable-site', () => window.setTimeout(disableCurrentSite, 0))
  appEventTarget = container
  appRoot = createRoot(container)
  appRoot.render(<App messageTarget={container} />)
}

async function mountIfAllowed() {
  if (mountPending || appEventTarget) return
  mountPending = true
  try {
    if (document.querySelector('input[type="password"]')) return
    const settings = await readSettings()
    if (!isHostDisabled(location.hostname, settings)) mount()
  } finally { mountPending = false }
}

async function enableCurrentSite(messageType: string) {
  const settings = await readSettings()
  const host = normalizeHost(location.hostname)
  const next = {
    ...settings,
    disabledHosts: settings.disabledHosts.filter((rule) => rule !== host),
    enabledHosts: [...new Set([...settings.enabledHosts.filter((rule) => rule !== host), host])],
  }
  await writeSettings(next)
  mount()
  const eventType = messageType === 'DEVNOTES_CAPTURE_SELECTION' ? 'devnotes-capture-selection'
    : messageType === 'DEVNOTES_NEW_NOTE' ? 'devnotes-new-note'
      : messageType === 'DEVNOTES_FOCUS_SEARCH' ? 'devnotes-focus-search' : 'devnotes-toggle'
  window.setTimeout(() => appEventTarget?.dispatchEvent(new Event(eventType)), 50)
}

function disableCurrentSite() {
  appRoot?.unmount()
  document.getElementById('devnotes-root')?.remove()
  appRoot = null
  appEventTarget = null
}

// Only inject on http/https pages
if (/^https?:/.test(location.protocol)) {
  void mountIfAllowed()
}

const pageGuard = new MutationObserver(() => {
  if (document.querySelector('input[type="password"]')) {
    if (appEventTarget) disableCurrentSite()
    return
  }
  if (appEventTarget && !document.getElementById('devnotes-root')) {
    appRoot = null
    appEventTarget = null
    void mountIfAllowed()
  }
})
if (document.documentElement) pageGuard.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] })

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message?.type === 'string' && message.type.startsWith('DEVNOTES_') && !appEventTarget) { void enableCurrentSite(message.type); return }
    if (!appEventTarget) return
    if (message?.type === 'DEVNOTES_TOGGLE') appEventTarget.dispatchEvent(new Event('devnotes-toggle'))
    if (message?.type === 'DEVNOTES_FOCUS_SEARCH') appEventTarget.dispatchEvent(new Event('devnotes-focus-search'))
    if (message?.type === 'DEVNOTES_CAPTURE_SELECTION') appEventTarget.dispatchEvent(new Event('devnotes-capture-selection'))
    if (message?.type === 'DEVNOTES_NEW_NOTE') appEventTarget.dispatchEvent(new Event('devnotes-new-note'))
  })
}
