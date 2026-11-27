import { chromium } from 'playwright'
import fs from 'fs'

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs>
    <linearGradient id="iris-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
  </defs>
  <!-- Rounded container badge matching dn-brand-icon -->
  <rect x="2" y="2" width="44" height="44" rx="10" fill="url(#iris-bg)" stroke="#312e81" stroke-width="1.5" />
  
  <!-- Serif lettermark i. with accent dot -->
  <text x="21" y="33" font-family="Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif" font-size="28" font-weight="700" fill="#f8fafc" text-anchor="middle">i<tspan fill="#818cf8">.</tspan></text>
</svg>`

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()

  fs.writeFileSync('public/favicon.svg', svgContent, 'utf-8')
  fs.writeFileSync('public/icon.svg', svgContent, 'utf-8')

  const html = `<!DOCTYPE html>
  <html>
    <head>
      <style>
        body { margin: 0; padding: 0; background: transparent; }
      </style>
    </head>
    <body>
      ${svgContent}
    </body>
  </html>`

  const sizes = [16, 32, 48, 128]
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(html.replace('width="48" height="48"', `width="${size}" height="${size}"`))
    await page.screenshot({
      path: `public/icon${size}.png`,
      omitBackground: true,
    })
    console.log(`Generated icon${size}.png`)
  }

  await browser.close()
}

main().catch(console.error)
