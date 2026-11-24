import { readFile } from 'node:fs/promises'

const css = await readFile(new URL('../src/App.css', import.meta.url), 'utf8')

function token(name) {
  const match = css.match(new RegExp(`--dn-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`Missing color token --dn-${name}`)
  return match[1]
}

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255)
  const [r, g, b] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(left, right) {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

for (const theme of ['light', 'dark', 'sepia']) {
  const surface = token(`${theme}-${theme === 'dark' ? 'bg' : 'surface'}`)
  for (const role of ['text', 'muted', 'accent']) {
    const foreground = token(`${theme}-${role}`)
    const ratio = contrast(foreground, surface)
    if (ratio < 4.5) throw new Error(`${theme} ${role} contrast is ${ratio.toFixed(2)}:1 (needs 4.5:1)`)
    process.stdout.write(`${theme} ${role}: ${ratio.toFixed(2)}:1\n`)
  }
}
