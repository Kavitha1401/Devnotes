import { chromium } from 'playwright'

async function test() {
  const browser = await chromium.launch()
  const page = await browser.newPage()

  await page.setContent(`<!DOCTYPE html>
  <html>
    <head>
      <style>
        :root {
          --dn-bg: #0b1120;
          --dn-surface: #1e293b;
          --dn-border: #334155;
          --dn-text: #f8fafc;
          --dn-accent: #38bdf8;
          --dn-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          --dn-font-serif: Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
        }
        body {
          background: #0b1329;
          color: #f8fafc;
          font-family: var(--dn-font);
          display: flex;
          flex-direction: column;
          gap: 24px;
          padding: 40px;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 20px;
        }
        .label {
          font-size: 12px;
          color: #94a3b8;
          width: 140px;
        }
        .dn-brand {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          user-select: none;
        }
        .dn-brand-text {
          font-size: 14.5px;
          font-weight: 600;
          letter-spacing: -0.2px;
          line-height: 1;
          color: var(--dn-text);
        }
        
        /* Original CSS with text */
        .box-orig {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 6px;
          background: var(--dn-bg);
          border: 1px solid var(--dn-border);
          color: var(--dn-text);
          font-family: var(--dn-font-serif);
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
        }
        .box-orig span { color: var(--dn-accent); }

        /* Adjusted CSS with optical shift */
        .box-css-tuned {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 6px;
          background: var(--dn-bg);
          border: 1px solid var(--dn-border);
          color: var(--dn-text);
          font-family: var(--dn-font-serif);
          font-size: 14.5px;
          font-weight: 700;
          line-height: 1;
          padding-left: 2px; /* optical compensation for right dot */
        }
        .box-css-tuned span { color: var(--dn-accent); margin-left: 0.5px; }

        /* Optical SVG Bold Serif */
        .box-svg {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 6px;
          background: var(--dn-bg);
          border: 1px solid var(--dn-border);
          color: var(--dn-text);
          box-sizing: border-box;
        }
      </style>
    </head>
    <body>
      <div style="transform: scale(2.5); transform-origin: top left; display: flex; flex-direction: column; gap: 16px;">
        <div class="row">
          <span class="label">1. Tuned CSS:</span>
          <div class="dn-brand">
            <span class="box-css-tuned">i<span>.</span></span>
            <span class="dn-brand-text">iris</span>
          </div>
        </div>

        <div class="row">
          <span class="label">2. Tuned CSS + 3px:</span>
          <div class="dn-brand">
            <span class="box-css-tuned" style="padding-left: 3px;">i<span>.</span></span>
            <span class="dn-brand-text">iris</span>
          </div>
        </div>

        <div class="row">
          <span class="label">3. Optical SVG:</span>
          <div class="dn-brand">
            <span class="box-svg">
              <svg viewBox="0 0 22 22" width="15" height="15" fill="none">
                <circle cx="8" cy="4.5" r="1.7" fill="#ffffff" />
                <path d="M 5.5 8 H 10.5 M 8 8 V 16.5 M 5.2 16.5 H 10.8" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" />
                <circle cx="14.8" cy="16.2" r="1.6" fill="#38bdf8" />
              </svg>
            </span>
            <span class="dn-brand-text">iris</span>
          </div>
        </div>

        <div class="row">
          <span class="label">4. Optical SVG Bold:</span>
          <div class="dn-brand">
            <span class="box-svg">
              <svg viewBox="0 0 22 22" width="16" height="16" fill="none">
                <circle cx="8.5" cy="4.2" r="1.9" fill="#ffffff" />
                <path d="M 5.8 7.8 H 11.2 M 8.5 7.8 V 16.8 M 5.5 16.8 H 11.5" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" />
                <circle cx="15.2" cy="16.5" r="1.8" fill="#38bdf8" />
              </svg>
            </span>
            <span class="dn-brand-text">iris</span>
          </div>
        </div>
      </div>
    </body>
  </html>`)

  await page.screenshot({ path: 'scratch/brand-comparison.png' })
  await browser.close()
  console.log('Saved scratch/brand-comparison.png')
}

test().catch(console.error)
