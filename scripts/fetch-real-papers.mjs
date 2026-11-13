#!/usr/bin/env node
// M6 段3 の確かめに使う実際の論文（本文と SI）を、tests/llm-eval/real-papers.json の入手先から取ってくる。
// PDF はリポジトリに入れない（tests/llm-eval/real-papers/ は .gitignore）。中身が記録と同じか（SHA-256）を確かめる。
// 取るのは curl（Windows・Mac・Linux に入っていて、プロキシの環境変数にも従う）
//
//   node scripts/fetch-real-papers.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const LIST = 'tests/llm-eval/real-papers.json';
const DIR = 'tests/llm-eval/real-papers';
const { papers } = JSON.parse(readFileSync(LIST, 'utf8'));
mkdirSync(DIR, { recursive: true });

const sha = (b) => createHash('sha256').update(b).digest('hex');
let bad = 0;
for (const p of papers) {
  for (const [kind, url] of [['main', p.main], ['si', p.si]]) {
    const file = `${DIR}/${p.id}${kind === 'si' ? '-S1' : ''}.pdf`;
    if (existsSync(file) && sha(readFileSync(file)) === p.sha256[kind]) {
      console.log(`あり: ${file}`);
      continue;
    }
    try {
      execFileSync('curl', ['-sSLf', '--max-time', '120', '-o', file, url], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch {
      console.error(`取れませんでした: ${url}`);
      bad++;
      continue;
    }
    const buf = readFileSync(file);
    const ok = sha(buf) === p.sha256[kind];
    if (!ok) bad++;
    console.log(`${ok ? '取った' : '中身が記録と違う'}: ${file}（${Math.round(buf.length / 1024)} KB）`);
  }
}
process.exit(bad ? 1 : 0);
