// Records what the Latch console actually does, so it can be reviewed without opening a browser.
// Usage (from the repo root):
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/see.mjs                         # tests the live site
//   node scripts/see.mjs http://localhost:8787   # or any other URL / file:///path/index.html
// Output: ./see-out/ (screenshots, video .webm, report.json). Upload the folder's contents.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.argv[2] || 'https://okblatch.xyz/';
const OUT = 'see-out';
const OWNER = '0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const report = { url: URL, runs: [] };

async function run(name, withMockWallet) {
  const run = { name, console: [], pageErrors: [], failedRequests: [], rpcCalls: [], notes: [] };
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(process.env.NOVIDEO ? {} : { recordVideo: { dir: `${OUT}/video-${name}`, size: { width: 1280, height: 900 } } }),
  });
  if (withMockWallet) {
    // A minimal EIP-1193 wallet that logs every request it receives.
    await ctx.addInitScript((owner) => {
      window.__walletLog = [];
      let chain = '0xc4'; // 196 = X Layer
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          window.__walletLog.push(method);
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
          if (method === 'eth_chainId') return chain;
          if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
          throw Object.assign(new Error('mock wallet: ' + method + ' not supported'), { code: -32601 });
        },
        on() {}, removeListener() {},
      };
    }, OWNER);
  }
  const page = await ctx.newPage();
  page.on('console', (m) => run.console.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => run.pageErrors.push(String(e && e.stack || e)));
  page.on('requestfailed', (r) => run.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
  page.on('request', (r) => { if (r.method() === 'POST' && /rpc|okx|xlayer/i.test(r.url())) run.rpcCalls.push(r.url()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => run.notes.push('goto: ' + e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}-1-loaded.png`, fullPage: true });

  const buttons = await page.$$eval('button', (bs) => bs.map((b) => b.innerText.trim()).filter(Boolean));
  run.buttons = buttons;

  const target = page.getByRole('button', { name: /connect wallet/i }).first();
  const count = await page.getByRole('button', { name: /connect wallet/i }).count();
  run.notes.push(`"Connect wallet" buttons found: ${count}`);
  if (count) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 5000 }).catch((e) => run.notes.push('click failed: ' + e.message.split('\n')[0]));
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${OUT}/${name}-2-after-connect-click.png`, fullPage: true });
  }
  run.walletRequests = await page.evaluate(() => window.__walletLog || null).catch(() => null);
  run.hasWindowEthereum = await page.evaluate(() => !!window.ethereum).catch(() => null);
  run.hasOkxwallet = await page.evaluate(() => !!window.okxwallet).catch(() => null);
  run.appConfig = await page.evaluate(() => JSON.stringify(window.APP_CONFIG || null)).catch(() => null);
  run.visibleText = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 4000);

  await ctx.close(); // flushes the video
  await browser.close();
  report.runs.push(run);
}

await run('no-wallet', false);   // what a visitor with no extension sees
await run('mock-wallet', true);  // what happens when a wallet is present and approves

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
for (const r of report.runs) {
  console.log(`\n== ${r.name} ==`);
  console.log('notes:', r.notes.join(' | ') || '-');
  console.log('page errors:', r.pageErrors.length, '| failed requests:', r.failedRequests.length);
  console.log('wallet requests seen:', JSON.stringify(r.walletRequests));
}
console.log(`\nDone. Upload everything in ./${OUT}/ (png, webm, report.json).`);
