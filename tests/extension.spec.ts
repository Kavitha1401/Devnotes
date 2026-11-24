import { test, expect, chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

test('loads the MV3 extension and mounts DevNotes on a web page', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Reading the web with care</title><style>body{margin:0;background:#f4f5f1;color:#253229;font:17px/1.75 system-ui}main{max-width:820px;margin:72px auto;padding:0 40px}h1{font:600 42px/1.15 Georgia,serif;letter-spacing:-1px}p{max-width:68ch}</style><main><article><p>FIELD NOTES - 6 MIN READ</p><h1>Reading the web with care</h1><p>Good ideas rarely arrive in a straight line. They emerge as we follow a question, notice a detail, and connect it to something we have seen before.</p><p>A useful reading practice leaves room for both attention and return. Mark the passage that matters, write down why it matters, and make the next step small enough to begin.</p><p>Notes work best when they stay close to their source. Later, a short explanation can bring the context back without asking you to read everything again.</p></article></main>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port')
  const profile = await mkdtemp(resolve(tmpdir(), 'devnotes-playwright-'))
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1500, height: 1000 },
      args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
    })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.setViewportSize({ width: 1920, height: 1080 })
    await expect(page.locator('#devnotes-root')).toBeAttached({ timeout: 15_000 })
    await expect.poll(() => context?.serviceWorkers().length ?? 0).toBeGreaterThan(0)
    await mkdir('screenshots', { recursive: true })
    await page.screenshot({ path: 'screenshots/devnotes-first-run.png', fullPage: true })
  } finally {
    await context?.close()
    server.close()
    await rm(profile, { recursive: true, force: true })
  }
})
