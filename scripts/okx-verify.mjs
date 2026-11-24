// Verify the two v2 contracts (built with via-IR) through OKX's X Layer Data API, which has a `viaIr` switch
// that OKLink's older route lacks. Sends no transaction and costs nothing.
//
//   1. ./scripts/oklink-manual.sh                 (creates oklink-verify/*.json from your Foundry build)
//   2. put your OKX Developer-portal API key in keeper/.env:
//        OKX_API_KEY=...   OKX_SECRET_KEY=...   OKX_PASSPHRASE=...
//   3. node scripts/okx-verify.mjs
//
// Docs: Onchain OS → X Layer → Data → Contract verification → "Verify Contract Source Code"
//   POST https://web3.okx.com/api/v5/xlayer/contract/verify-source-code
// Requests are signed the OKX way: OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + method + path + body)).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (fs.existsSync(path.join(root, 'keeper/.env')) ? fs.readFileSync(path.join(root, 'keeper/.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { OKX_API_KEY: KEY, OKX_SECRET_KEY: SECRET, OKX_PASSPHRASE: PASS } = process.env;
if (!KEY || !SECRET || !PASS) {
  console.error('STOP: add OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE (from the OKX Developer portal) to keeper/.env');
  process.exit(1);
}
const BASE = 'https://web3.okx.com';
const VERIFY = '/api/v5/xlayer/contract/verify-source-code';
const CHECK = process.env.OKX_CHECK_PATH || '/api/v5/xlayer/contract/check-verify-result';
const FAC2 = '0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8';
const IMPL = '0x8C86977F520E5A0e913812Bf015B1fb595b2BBD2';

async function call(method, p, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const ts = new Date().toISOString();
  const sign = crypto.createHmac('sha256', SECRET).update(ts + method + p + body).digest('base64');
  const r = await fetch(BASE + p, {
    method, body: body || undefined,
    headers: { 'OK-ACCESS-KEY': KEY, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-PASSPHRASE': PASS, 'OK-ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { code: String(r.status), msg: text.slice(0, 300) }; }
}

async function verify(label, address, file, names) {
  const json = fs.readFileSync(path.join(root, 'oklink-verify', file), 'utf8');
  const settings = JSON.parse(json).settings || {};
  console.log(`\n== ${label} ${address}  (viaIR ${settings.viaIR}, evm ${settings.evmVersion}, optimizer ${settings.optimizer?.runs})`);
  for (const contractName of names) {
    const res = await call('POST', VERIFY, {
      chainShortName: 'XLAYER', contractAddress: address, contractName, sourceCode: json,
      codeFormat: 'solidity-standard-json-input', compilerVersion: 'v0.8.24+commit.e11b9ed9',
      optimization: '1', optimizationRuns: '200', evmVersion: 'cancun', viaIr: true, licenseType: 'GNU GPLv2'
    });
    console.log(`  submit (contractName "${contractName}"): code ${res.code} ${res.msg || ''} ${JSON.stringify(res.data || '')}`);
    if (res.code !== '0' || !res.data?.[0]) continue;
    const guid = res.data[0];
    for (let i = 0; i < 12; i++) {
      await new Promise((s) => setTimeout(s, 10_000));
      const st = await call('POST', CHECK, { chainShortName: 'XLAYER', guid });
      const word = JSON.stringify(st.data ?? st.msg ?? '');
      console.log(`  result: ${word}`);
      if (/success|pass|verified/i.test(word) && !/fail|unable/i.test(word)) return true;
      if (/fail|unable|error/i.test(word)) break;
    }
  }
  return false;
}

const a = await verify('LatchFactory2', FAC2, 'LatchFactory2.json', ['LatchFactory2', 'contracts/LatchFactory2.sol:LatchFactory2']);
const b = await verify('LatchVault template', IMPL, 'LatchVault.json', ['LatchVault', 'contracts/LatchVault.sol:LatchVault']);
console.log(`\nLatchFactory2: ${a ? 'VERIFIED' : 'not yet'} · LatchVault template: ${b ? 'VERIFIED' : 'not yet'}`);
console.log(`Check: https://www.oklink.com/xlayer/address/${FAC2}  and  https://web3.okx.com/explorer/x-layer/address/${FAC2}`);
if (!(a && b)) console.log('If a result line shows nothing useful, open the pages above in 2 minutes: verification can finish after the script stops. Paste this output to Claude otherwise.');
