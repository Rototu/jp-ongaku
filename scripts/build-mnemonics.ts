#!/usr/bin/env bun
/**
 * Builds the kanji mnemonic artifact: a hook for the meaning and one for the
 * sound, for every character in the dictionary.
 *
 *   bun run mnemonics              # cover everything still missing
 *   bun run mnemonics --limit 60   # a taste, to read before spending the rest
 *   bun run mnemonics --only 夜空  # specific characters
 *   bun run mnemonics --force      # rewrite hooks that already exist
 *   bun run mnemonics --compile    # rebuild the database from the JSONL, no model
 *
 * Resumable by construction. Every batch is appended to the JSONL as it lands, so
 * an interrupted run — or a rate limit, or a closed laptop — loses at most the
 * batches in flight, and starting again skips everything already covered.
 *
 * Two things make this worth doing up front rather than per word:
 *
 *   1. Components. KRADFILE says what each character is built from, and the
 *      characters are covered shortest-first, so by the time 語 is asked about,
 *      言 and 五 and 口 already have names — which are passed in, so the parts are
 *      called the same thing everywhere. That consistency is most of what makes
 *      WaniKani's mnemonics work, and a single word tap cannot have it.
 *   2. Checking. A reading hook is supposed to be built around a real reading;
 *      here there is time to verify that and to ask again when it is not.
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  DICT_DB,
  MNEMONIC_JSONL,
  MNEMONIC_META,
  RAW_DIR,
  ensureDirs,
} from '../server/paths';
import { compile, type MnemonicRow } from '../server/mnemonics';
import { kanjiMnemonicPrompt, parseKanjiMnemonics, type KanjiFacts } from '../server/llm/analyze';
import { complete, resolveProvider } from '../server/llm/provider';
import { getSetting } from '../server/db';
import { hiragana, toRomaji } from '../server/nlp/kana';
import { join } from 'node:path';

const GH_JMDICT = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';
/** Characters per request. Six keeps each hook thought about and each retry cheap. */
const BATCH = 6;

interface Args {
  limit: number | null;
  only: string[];
  force: boolean;
  compileOnly: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    limit: null,
    only: [],
    force: false,
    compileOnly: false,
    concurrency: Number(getSetting('llm_concurrency') ?? '4') || 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--only') out.only = [...(argv[++i] ?? '')].filter((c) => /[一-龯]/.test(c));
    else if (arg === '--force') out.force = true;
    else if (arg === '--compile') out.compileOnly = true;
    else if (arg === '--concurrency') out.concurrency = Number(argv[++i]) || out.concurrency;
  }
  return out;
}

// --- the source characters --------------------------------------------------

interface KanjiRow {
  char: string;
  meanings: string;
  on_yomi: string;
  kun_yomi: string;
  grade: number | null;
  freq: number | null;
  strokes: number | null;
}

/**
 * Every character in the dictionary, simplest first.
 *
 * Stroke count is the ordering that makes the glossary work: a part is almost
 * always simpler than the characters built from it, so covering by strokes means
 * the part already has a name by the time it is needed. Frequency breaks ties so
 * that an interrupted run has covered the characters a learner will actually meet.
 */
function sourceCharacters(): KanjiFacts[] {
  if (!existsSync(DICT_DB)) {
    throw new Error('data/dict.db is missing. Run: bun run dict');
  }
  const db = new Database(DICT_DB, { readonly: true });
  const rows = db
    .query<KanjiRow, []>(
      `SELECT char, meanings, on_yomi, kun_yomi, grade, freq, strokes FROM kanji
       ORDER BY COALESCE(strokes, 99),
                CASE WHEN freq IS NULL THEN 1 ELSE 0 END,
                COALESCE(freq, 999999),
                char`,
    )
    .all();
  db.close();

  return rows.map((r) => ({
    char: r.char,
    meanings: JSON.parse(r.meanings) as string[],
    on: JSON.parse(r.on_yomi) as string[],
    kun: JSON.parse(r.kun_yomi) as string[],
  }));
}

// --- components, from KRADFILE ----------------------------------------------

async function releaseAsset(pattern: RegExp): Promise<{ name: string; url: string }> {
  const res = await fetch(GH_JMDICT, {
    headers: { 'User-Agent': 'jp-ongaku', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for the jmdict-simplified release`);
  const json = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  const hit = json.assets.find((a) => pattern.test(a.name));
  if (!hit) throw new Error(`No asset matching ${pattern} in the release`);
  return { name: hit.name, url: hit.browser_download_url };
}

/**
 * char -> the parts it is written with.
 *
 * KRADFILE ships in the same release the dictionary already comes from, under the
 * same EDRDG licence, so this costs one more download and no new dependency.
 */
async function componentMap(): Promise<Record<string, string[]>> {
  const asset = await releaseAsset(/^kradfile-.*\.json\.tgz$/);
  const path = join(RAW_DIR, 'kradfile.json.tgz');
  if (!existsSync(path) || statSync(path).size === 0) {
    console.log(`  fetch   ${asset.name}`);
    const res = await fetch(asset.url, { headers: { 'User-Agent': 'jp-ongaku' } });
    if (!res.ok) throw new Error(`Download failed ${res.status} for ${asset.name}`);
    await Bun.write(path, res);
  } else {
    console.log('  cached  kradfile.json.tgz');
  }

  const proc = Bun.spawn(['tar', '-xzOf', path], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`tar failed for ${path}: ${await new Response(proc.stderr).text()}`);
  }
  const parsed = JSON.parse(text) as { kanji?: Record<string, string[]> };
  return parsed.kanji ?? {};
}

/**
 * A single English name per component, so hooks can agree on what to call it.
 *
 * Most components are themselves characters in the dictionary, so their own first
 * meaning is the name. The rest are the standalone radical forms, which have no
 * dictionary entry and are named here once.
 */
const RADICAL_NAMES: Record<string, string> = {
  // Six of KRADFILE's parts are written as katakana, as shape conventions rather
  // than as characters. Named for their shape on purpose: calling ヨ a "comb"
  // invents a meaning the stroke does not carry, and a hook would then be built
  // on the invention.
  'ノ': 'a sweeping stroke',
  '｜': 'a vertical stroke',
  'ハ': 'two splayed strokes',
  'ヨ': 'three stacked strokes',
  'マ': 'a マ-shaped stroke',
  'ユ': 'a ユ-shaped stroke',

  // KRADFILE also writes some radicals as a whole kanji that contains them, and
  // taking the dictionary meaning of that stand-in names the part after the wrong
  // thing entirely: 汁 here means "the water radical", not "soup". Each of these
  // was confirmed by looking at what the characters using it have in common.
  '汁': 'water at the side', // 氵
  '扎': 'a hand at the side', // 扌
  '忙': 'a heart at the side', // 忄
  '艾': 'grass on top', // 艹
  '杰': 'four dots at the bottom', // 灬
  '化': 'a person at the side', // 亻
  '个': 'a hat on top', // 𠆢
  '并': 'two short strokes on top', // 丷
  // What 乞 stands in for is not clear from the data, so it is named after its own
  // shape rather than after a guess.
  '乞': 'the 乞-shaped part',

  // Radicals whose first dictionary meaning is a poor image to build on. 厂 is a
  // cliff in every kanji that uses it; "wild goose" is a reading of the character
  // in isolation and would send every hook somewhere strange.
  '厂': 'a cliff',
  '乙': 'a hook stroke',
  '亅': 'a barb',
  '又': 'a right hand',
  '厶': 'the katakana-mu shape',
  '冂': 'an upside-down box',
  '亠': 'a lid',
  '儿': 'a pair of legs',
  '冖': 'a crown',
  '宀': 'a roof',
  '匕': 'a spoon',
  '尸': 'a flag',
  '廾': 'two hands',
  '卜': 'a divining rod',
  '夂': 'a stooping figure',
  '冫': 'ice',
  '禾': 'a grain stalk',
  '隹': 'an old bird',
  '幺': 'a short thread',
  '戈': 'a halberd',
};

/**
 * Names a component after its first dictionary meaning, minus the parts of that
 * meaning which are about the dictionary rather than the character.
 *
 * KANJIDIC writes radicals as "kettle lid radical (no. 8)" and "spoon or katakana
 * hi radical (no. 21)". Left alone, that numbering ends up inside hooks the
 * learner reads.
 */
function cleanName(meaning: string): string {
  const trimmed = meaning
    .toLowerCase()
    .replace(/\s*\(no\.\s*\d+\)\s*/g, ' ')
    .replace(/\bradical\b/g, ' ')
    .replace(/\bor katakana\s+\w+\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return trimmed;
}

function componentNames(facts: KanjiFacts[]): Record<string, string> {
  const names: Record<string, string> = { ...RADICAL_NAMES };
  for (const f of facts) {
    if (names[f.char]) continue;
    const first = cleanName(f.meanings[0] ?? '');
    if (first) names[f.char] = first;
  }
  return names;
}

// --- the JSONL, which is the artifact ---------------------------------------

function readExisting(): Map<string, MnemonicRow> {
  const out = new Map<string, MnemonicRow>();
  if (!existsSync(MNEMONIC_JSONL)) return out;
  for (const line of readFileSync(MNEMONIC_JSONL, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as MnemonicRow;
      // A later line for the same character wins, which is what makes appending
      // safe: the rewrite at the end collapses them.
      if (row.char && row.meaning && row.reading) out.set(row.char, row);
    } catch {
      /* a torn last line from an interrupted run */
    }
  }
  return out;
}

/** One object per line, sorted by codepoint, so a diff is readable. */
function rewriteSorted(rows: Map<string, MnemonicRow>): void {
  const sorted = [...rows.values()].sort((a, b) =>
    (a.char.codePointAt(0) ?? 0) - (b.char.codePointAt(0) ?? 0),
  );
  const body = sorted.map((r) => JSON.stringify(serialise(r))).join('\n');
  writeFileSync(MNEMONIC_JSONL, body + (body ? '\n' : ''));
}

/** Fixed key order, so re-serialising never produces a spurious diff. */
function serialise(row: MnemonicRow): Record<string, unknown> {
  return {
    char: row.char,
    meaning: row.meaning,
    reading: row.reading,
    readingKey: row.readingKey,
    components: row.components,
  };
}

// --- checking ---------------------------------------------------------------

/**
 * Whether a reading hook visibly leans on the sound it claims to teach.
 *
 * A nudge, not a verdict. It looks for the romaji of the reading in the hook,
 * forgiving long-vowel spelling (kuu also matches "ku"), because a hook built on
 * ヤ almost always contains the letters "ya" somewhere — "Yah!", "yacht",
 * "yard". An honest hook that spells its sound-alike unusually will fail this,
 * which is why failing costs one extra request and never the hook itself.
 *
 * Readings whose romaji is a bare vowel are not checked at all: looking for "a"
 * in an English sentence proves nothing.
 */
export function readingHookLooksSound(hook: string, readingKey: string): boolean {
  if (!readingKey) return false;
  const romaji = toRomaji(hiragana(readingKey.replace(/[.\-\u2010]/g, '')));
  if (romaji.length < 2) return true;

  const candidates = new Set([romaji]);
  // kuu -> ku, ou -> o, and the same for the first syllable on its own, so a
  // two-kana reading is not required to appear in full.
  candidates.add(romaji.replace(/([aiueo])\1+/g, '$1'));
  candidates.add(romaji.replace(/ou/g, 'o').replace(/uu/g, 'u'));
  const firstSyllable = /^([kstnhmyrwgzjdbp]?[yh]?[aiueo]|shi|chi|tsu|sh|ch|ts)/.exec(romaji)?.[1];
  if (firstSyllable && firstSyllable.length >= 2) candidates.add(firstSyllable);

  const haystack = hook.toLowerCase();
  return [...candidates].some((c) => c.length >= 2 && haystack.includes(c));
}

// --- the run ----------------------------------------------------------------

async function main() {
  ensureDirs();
  const args = parseArgs(Bun.argv.slice(2));

  if (args.compileOnly) {
    const rows = compile();
    console.log(`compiled ${rows} hooks -> data/mnemonics.db`);
    return;
  }

  const provider = resolveProvider();
  if (provider.name === 'none') {
    throw new Error('No AI provider configured. Set one in Settings, or pass --compile.');
  }

  console.log('reading the dictionary…');
  const all = sourceCharacters();
  console.log(`  ${all.length} characters`);

  console.log('resolving components…');
  const components = await componentMap();
  const names = componentNames(all);
  const withParts = all.map((f) => ({
    ...f,
    components: (components[f.char] ?? []).filter((c) => c !== f.char),
  }));
  console.log(`  ${Object.keys(components).length} characters decomposed`);

  const existing = readExisting();
  console.log(`  ${existing.size} hooks already written`);

  let todo = withParts;
  if (args.only.length > 0) {
    const wanted = new Set(args.only);
    todo = todo.filter((f) => wanted.has(f.char));
  }
  if (!args.force) todo = todo.filter((f) => !existing.has(f.char));
  if (args.limit !== null) todo = todo.slice(0, args.limit);

  if (todo.length === 0) {
    console.log('\nnothing to do. Compiling the database from what is there.');
    const rows = compile();
    console.log(`compiled ${rows} hooks -> data/mnemonics.db`);
    return;
  }

  const batches: KanjiFacts[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  const model = getSetting('gateway_model') ?? provider.name;
  console.log(
    `\nwriting hooks for ${todo.length} characters in ${batches.length} batches ` +
      `of ${BATCH}, ${args.concurrency} at a time, with ${model}\n`,
  );

  let done = 0;
  let written = 0;
  let reasked = 0;
  let failed = 0;
  const started = Date.now();

  /**
   * Names for this batch's parts, taken from what the artifact already says.
   *
   * Only parts whose own hook exists get a name, because a name is only worth
   * fixing once it has been used in a hook the learner may already have read.
   */
  const glossaryFor = (batch: KanjiFacts[]): [string, string][] => {
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const f of batch) {
      for (const part of f.components ?? []) {
        if (seen.has(part)) continue;
        seen.add(part);
        const name = names[part];
        if (name && (existing.has(part) || RADICAL_NAMES[part])) out.push([part, name]);
      }
    }
    return out;
  };

  const runBatch = async (batch: KanjiFacts[]): Promise<void> => {
    const glossary = glossaryFor(batch);
    let hooks: ReturnType<typeof parseKanjiMnemonics> = [];
    try {
      hooks = parseKanjiMnemonics(await complete(kanjiMnemonicPrompt(batch, glossary)), batch);
    } catch (err) {
      failed += batch.length;
      console.error(`  ! ${batch.map((f) => f.char).join('')} — ${(err as Error).message}`);
      return;
    }

    // Ask again for the ones whose sound-alike does not contain the sound, with
    // the complaint attached. Once only: the second answer is kept either way.
    const weak = hooks.filter((h) => !readingHookLooksSound(h.reading, h.readingKey));
    if (weak.length > 0) {
      reasked += weak.length;
      const retryFacts = batch.filter((f) => weak.some((w) => w.char === f.char));
      const complaint =
        `\nThe reading hooks for ${weak.map((w) => w.char).join('、')} did not contain the sound ` +
        `of the reading they named. Write those again with a sound-alike that really does.`;
      try {
        const second = parseKanjiMnemonics(
          await complete(kanjiMnemonicPrompt(retryFacts, glossary) + complaint),
          retryFacts,
        );
        for (const better of second) {
          const at = hooks.findIndex((h) => h.char === better.char);
          if (at !== -1 && readingHookLooksSound(better.reading, better.readingKey)) {
            hooks[at] = better;
          }
        }
      } catch {
        /* keep the first answer */
      }
    }

    const lines: string[] = [];
    for (const hook of hooks) {
      const facts = batch.find((f) => f.char === hook.char);
      const row: MnemonicRow = { ...hook, components: facts?.components ?? [] };
      existing.set(row.char, row);
      lines.push(JSON.stringify(serialise(row)));
      written++;
    }
    // Appended as each batch lands, so an interruption keeps everything before it.
    if (lines.length > 0) appendFileSync(MNEMONIC_JSONL, lines.join('\n') + '\n');
    failed += batch.length - hooks.length;

    done++;
    if (done % 10 === 0 || done === batches.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / elapsed;
      const left = Math.round((batches.length - done) / Math.max(rate, 0.001) / 60);
      console.log(
        `  ${done}/${batches.length} batches · ${written} written · ${failed} missed · ` +
          `${left} min left`,
      );
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= batches.length) return;
      await runBatch(batches[at]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(args.concurrency, batches.length)) }, () => worker()),
  );

  console.log('\nsorting the artifact…');
  rewriteSorted(existing);

  const rows = compile();
  writeFileSync(
    MNEMONIC_META,
    JSON.stringify(
      {
        generator: 'scripts/build-mnemonics.ts',
        model,
        characters: existing.size,
        updatedAt: new Date().toISOString(),
        sources: {
          kanji: 'KANJIDIC2 via scriptin/jmdict-simplified (CC BY-SA 4.0)',
          components: 'KRADFILE via scriptin/jmdict-simplified (EDRDG licence)',
        },
      },
      null,
      2,
    ) + '\n',
  );

  const mb = (statSync(MNEMONIC_JSONL).size / 1048576).toFixed(1);
  console.log(
    `\ndone. ${existing.size} characters covered (${mb} MB of JSONL, ${rows} rows compiled).\n` +
      `  written this run: ${written}   re-asked: ${reasked}   missed: ${failed}`,
  );
  if (failed > 0) console.log('  Missed characters are simply uncovered; run again to pick them up.');
}

// Only when run as a command. The checking helpers above are imported by the
// tests, and importing this file must not start spending money.
if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`\nmnemonic build failed: ${err.message}`);
    console.error('Whatever was written before the failure is kept. Run again to carry on.');
    process.exit(1);
  });
}
