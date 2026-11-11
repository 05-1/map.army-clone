import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
export const B = 'http://localhost:54399';
export async function launch() {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const open = async (w = 1440, h = 900) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
    await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
    const page = await ctx.newPage(); page.setDefaultTimeout(6000);
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|ERR_|AJAXError/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    page.on('dialog', (d) => d.accept());
    return page;
  };
  return { browser, open, errors };
}
export const texts = async (page, sel) => (await page.locator(sel).allTextContents()).map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
