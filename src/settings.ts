export const SETTINGS_KEY = 'devnotes-settings'
export const HIGHLIGHT_COLORS = ['#f6e58d', '#c8e6a0', '#b7dff2', '#f2c5d2'] as const

export type DevNotesSettings = {
  disabledHosts: string[]
  enabledHosts: string[]
  theme: 'light' | 'dark' | 'system' | 'sepia'
  panelSide: 'left' | 'right'
  panelWidth: number
  launcherPosition: 'bottom-left' | 'bottom-right'
  hideLauncher: boolean
  highlightColor: string
  trashRetentionDays: number
  historyDepth: number
  highlightStyle: 'marker' | 'underline' | 'box' | 'bracket'
  penSet: 'marker' | 'pencil' | 'fountain'
  noteFont: 'sans' | 'serif' | 'mono'
  toolbarBehavior: 'always' | 'hold-alt' | 'never'
  textSize: 'small' | 'medium' | 'large'
  onboardingComplete: boolean
}

export const DEFAULT_SETTINGS: DevNotesSettings = {
  disabledHosts: [],
  enabledHosts: [],
  theme: 'system',
  panelSide: 'right',
  panelWidth: 430,
  launcherPosition: 'bottom-right',
  hideLauncher: false,
  highlightColor: HIGHLIGHT_COLORS[0],
  trashRetentionDays: 180,
  historyDepth: 20,
  highlightStyle: 'marker',
  penSet: 'marker',
  noteFont: 'sans',
  toolbarBehavior: 'always',
  textSize: 'medium',
  onboardingComplete: false,
}

export const DEFAULT_BLOCKED_HOSTS = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'capitalone.com',
  'usbank.com',
]

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '')
}

export function normalizeSettings(value: unknown): DevNotesSettings {
  const raw = typeof value === 'object' && value !== null ? value as Partial<DevNotesSettings> & { paperTone?: string } : {}
  const strings = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string').map((item) => item.trim().startsWith('*.') ? `*.${normalizeHost(item.slice(2))}` : normalizeHost(item)).filter(Boolean) : []
  return {
    ...DEFAULT_SETTINGS,
    disabledHosts: [...new Set(strings(raw.disabledHosts))],
    enabledHosts: [...new Set(strings(raw.enabledHosts))],
    theme: raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'sepia' ? raw.theme : raw.paperTone === 'sepia' ? 'sepia' : raw.paperTone === 'night' ? 'dark' : 'system',
    panelSide: raw.panelSide === 'left' ? 'left' : 'right',
    panelWidth: typeof raw.panelWidth === 'number' ? Math.min(720, Math.max(360, Math.round(raw.panelWidth))) : DEFAULT_SETTINGS.panelWidth,
    launcherPosition: raw.launcherPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    hideLauncher: Boolean(raw.hideLauncher),
    highlightColor: HIGHLIGHT_COLORS.includes(raw.highlightColor as typeof HIGHLIGHT_COLORS[number]) ? raw.highlightColor as string : DEFAULT_SETTINGS.highlightColor,
    trashRetentionDays: typeof raw.trashRetentionDays === 'number' ? Math.min(3650, Math.max(30, Math.round(raw.trashRetentionDays))) : DEFAULT_SETTINGS.trashRetentionDays,
    historyDepth: typeof raw.historyDepth === 'number' ? Math.min(100, Math.max(1, Math.round(raw.historyDepth))) : DEFAULT_SETTINGS.historyDepth,
    highlightStyle: ['marker', 'underline', 'box', 'bracket'].includes(raw.highlightStyle as string) ? raw.highlightStyle as DevNotesSettings['highlightStyle'] : DEFAULT_SETTINGS.highlightStyle,
    penSet: ['marker', 'pencil', 'fountain'].includes(raw.penSet as string) ? raw.penSet as DevNotesSettings['penSet'] : DEFAULT_SETTINGS.penSet,
    noteFont: (['sans', 'serif', 'mono'] as string[]).includes(raw.noteFont as string)
      ? (raw.noteFont as DevNotesSettings['noteFont'])
      : (raw.noteFont as string) === 'handwriting'
        ? 'sans'
        : DEFAULT_SETTINGS.noteFont,
    toolbarBehavior: ['always', 'hold-alt', 'never'].includes(raw.toolbarBehavior as string) ? raw.toolbarBehavior as DevNotesSettings['toolbarBehavior'] : DEFAULT_SETTINGS.toolbarBehavior,
    textSize: ['small', 'medium', 'large'].includes(raw.textSize as string) ? raw.textSize as DevNotesSettings['textSize'] : DEFAULT_SETTINGS.textSize,
    onboardingComplete: Boolean(raw.onboardingComplete),
  }
}

export function hostMatches(host: string, rule: string): boolean {
  const wildcard = rule.trim().startsWith('*.')
  const normalizedHost = normalizeHost(host)
  const normalizedRule = normalizeHost(rule)
  if (wildcard) return normalizedHost !== normalizedRule && normalizedHost.endsWith(`.${normalizedRule}`)
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`)
}

export function isHostDisabled(host: string, settings: DevNotesSettings): boolean {
  if (settings.enabledHosts.some((rule) => hostMatches(host, rule))) return false
  return settings.disabledHosts.some((rule) => hostMatches(host, rule)) || DEFAULT_BLOCKED_HOSTS.some((rule) => hostMatches(host, rule))
}

export function readSettings(): Promise<DevNotesSettings> {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) { resolve(DEFAULT_SETTINGS); return }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(SETTINGS_KEY, (result) => resolve(normalizeSettings(result[SETTINGS_KEY])))
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { resolve(DEFAULT_SETTINGS); return }
    try { resolve(normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'))) } catch { resolve(DEFAULT_SETTINGS) }
  })
}

export function writeSettings(settings: DevNotesSettings): Promise<void> {
  const normalized = normalizeSettings(settings)
  return new Promise((resolve, reject) => {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) { resolve(); return }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [SETTINGS_KEY]: normalized }, () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
      return
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) { reject(new Error('Chrome storage is unavailable.')); return }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized)); resolve() } catch (error) { reject(error) }
  })
}
