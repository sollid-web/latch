// TapeKit's "100% on-chain" static rule for a DeWEB page (TapeKit SPEC §8): no off-chain URL in src/href/…
// attributes, srcset, CSS url() or @import, or a meta refresh. Data requests made by scripts are not covered.
//   node scripts/check-onchain.mjs [file]      (default public-onchain/index.html)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['attribute', /\b(?:src|href|action|poster|data|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi],
  ['srcset', /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi],
  ['css url()', /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi],
  ['@import', /@import\s+(?:"([^"]*)"|'([^']*)')/gi],
  ['meta refresh', /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url=([^"'>\s]+)/gi]
];
const external = (u) => /^(?:https?|wss?|ftp):/i.test(u.trim()) || u.trim().startsWith('//');
export function checkOnchain(text) {
  const hits = [];
  for (const [where, re] of RULES) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      const vals = where === 'srcset' ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v];
      for (const x of vals) if (x && external(x)) hits.push({ where, url: x, at: m.index });
    }
  }
  return hits;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || new URL('../public-onchain/index.html', import.meta.url);
  const hits = checkOnchain(fs.readFileSync(file, 'utf8'));
  if (hits.length) { for (const h of hits.slice(0, 20)) console.error(`  ${h.where}: ${h.url}`); process.exit(1); }
  console.log('on-chain pure (TapeKit static rule)');
}
