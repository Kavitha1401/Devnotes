import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs>
    <linearGradient id="iris-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
    <linearGradient id="iris-glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#c084fc" />
      <stop offset="50%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>
    <linearGradient id="petal-grad" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#e879f9" />
    </linearGradient>
  </defs>
  <!-- Rounded container badge for high contrast on any toolbar -->
  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#iris-bg)" stroke="#312e81" stroke-width="1.2" />
  
  <!-- Graceful eye / petal contour -->
  <path d="M 9 24 C 15 13, 33 13, 39 24 C 33 35, 15 35, 9 24 Z" 
        fill="none" 
        stroke="url(#iris-glow)" 
        stroke-width="2.6" 
        stroke-linecap="round" 
        stroke-linejoin="round" />
  
  <!-- Delicate botanical center iris petal / aperture -->
  <circle cx="24" cy="24" r="7.5" fill="none" stroke="url(#petal-grad)" stroke-width="2.2" />
  
  <!-- Central pupil / light reflection -->
  <circle cx="24" cy="24" r="3.2" fill="#ffffff" />
  
  <!-- Ethereal grace sparkle point -->
  <circle cx="27" cy="21" r="1.1" fill="#ffffff" opacity="0.9" />
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
