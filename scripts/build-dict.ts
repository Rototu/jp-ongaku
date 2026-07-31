#!/usr/bin/env bun
/**
 * Builds data/dict.db from open dictionary data:
 *   - JMdict (via scriptin/jmdict-simplified) -> words, readings, senses, frequency tags
 *   - JmdictFurigana (Doublevil)              -> kanji->reading alignment, so we never guess furigana
 *   - KANJIDIC2 (via jmdict-simplified)       -> per-kanji meanings/readings for the kanji deck
 *
 * Downloads are cached in data/raw/, so re-running is cheap. The resulting
 * dict.db is read-only at runtime and completely separate from the user's
 * progress database.
 */
import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DICT_DB, RAW_DIR, ensureDirs } from '../server/paths';
import { JLPT_LEVELS } from '../server/nlp/jlpt-data';

const GH_JMDICT = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';
const GH_FURIGANA = 'https://api.github.com/repos/Doublevil/JmdictFurigana/releases/latest';

interface Asset {
  name: string;
  browser_download_url: string;
}

async function releaseAssets(api: string): Promise<Asset[]> {
  const res = await fetch(api, {
    headers: { 'User-Agent': 'jp-ongaku', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${api}`);
  const json = (await res.json()) as { assets: Asset[] };
  return json.assets;
}

function pickAsset(assets: Asset[], predicate: (name: string) => boolean, label: string): Asset {
  const hit = assets.find((a) => predicate(a.name));
  if (!hit) throw new Error(`No ${label} asset found in release`);
  return hit;
}

async function download(url: string, dest: string) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  cached  ${dest.split('/').pop()}`);
    return;
  }
  console.log(`  fetch   ${url.split('/').pop()}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'jp-ongaku' } });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  await Bun.write(dest, res);
}

/** Decompress a .tgz containing a single JSON file and return the JSON text. */
async function readTgzJson(path: string): Promise<string> {
  const proc = Bun.spawn(['tar', '-xzOf', path], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar failed for ${path}: ${err}`);
  }
  return text;
}

/**
 * Splits the top-level objects out of a JSON array without parsing the whole
 * document into one giant object graph. Yields raw object substrings.
 */
function* iterArrayObjects(text: string, arrayKey: string): Generator<string> {
  const keyIdx = text.indexOf(`"${arrayKey}"`);
  if (keyIdx === -1) throw new Error(`key "${arrayKey}" not found`);
  let i = text.indexOf('[', keyIdx);
  if (i === -1) throw new Error(`array for "${arrayKey}" not found`);
  i++;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    } else if (c === ']' && depth === 0) {
      return;
    }
  }
}

// --- JMdict shapes (only the fields we consume) -----------------------------

interface JmKanji {
  text: string;
  common: boolean;
  tags: string[];
}
interface JmKana {
  text: string;
  common: boolean;
  tags: string[];
  appliesToKanji: string[];
}
interface JmGloss {
  text: string;
  lang: string;
}
interface JmSense {
  partOfSpeech: string[];
  misc: string[];
  info: string[];
  gloss: JmGloss[];
}
interface JmWord {
  id: string;
  kanji: JmKanji[];
  kana: JmKana[];
  sense: JmSense[];
}

/**
 * JMdict priority tags -> a coarse frequency rank. nf01 means "top 500 by
 * newspaper frequency", nf02 the next 500, and so on; ichi1/news1/spec1 mark
 * common words without a bucket.
 */
function freqRankFrom(tags: string[]): number | null {
  let best: number | null = null;
  for (const tag of tags) {
    let rank: number | null = null;
    const nf = /^nf(\d{2})$/.exec(tag);
    if (nf) rank = Number(nf[1]) * 500;
    else if (tag === 'ichi1' || tag === 'news1' || tag === 'spec1') rank = 5000;
    else if (tag === 'ichi2' || tag === 'news2' || tag === 'spec2') rank = 15000;
    else if (tag === 'gai1') rank = 8000;
    else if (tag === 'gai2') rank = 18000;
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

function buildJlptIndex(): Map<string, number> {
  const map = new Map<string, number>();
  // Lower level number = more advanced, so keep the easiest (highest N) level.
  for (const [levelStr, words] of Object.entries(JLPT_LEVELS)) {
    const level = Number(levelStr);
    for (const w of words) {
      const prev = map.get(w);
      if (prev === undefined || level > prev) map.set(w, level);
    }
  }
  return map;
}

async function main() {
  ensureDirs();
  console.log('jp-ongaku dictionary build');

  console.log('resolving releases…');
  const [jmAssets, furiAssets] = await Promise.all([
    releaseAssets(GH_JMDICT),
    releaseAssets(GH_FURIGANA),
  ]);

  const jmdict = pickAsset(
    jmAssets,
    (n) => /^jmdict-eng-\d.*\.json\.tgz$/.test(n),
    'jmdict-eng json.tgz',
  );
  const kanjidic = pickAsset(
    jmAssets,
    (n) => /^kanjidic2-en-\d.*\.json\.tgz$/.test(n),
    'kanjidic2-en json.tgz',
  );
  const furigana = pickAsset(
    furiAssets,
    (n) => n === 'JmdictFurigana.json.tar.gz',
    'JmdictFurigana.json.tar.gz',
  );

  const jmPath = join(RAW_DIR, 'jmdict-eng.json.tgz');
  const kdPath = join(RAW_DIR, 'kanjidic2-en.json.tgz');
  const fgPath = join(RAW_DIR, 'JmdictFurigana.json.tar.gz');

  await download(jmdict.browser_download_url, jmPath);
  await download(kanjidic.browser_download_url, kdPath);
  await download(furigana.browser_download_url, fgPath);

  if (existsSync(DICT_DB)) await Bun.file(DICT_DB).delete();
  const db = new Database(DICT_DB, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`
    CREATE TABLE entries (
      id         TEXT PRIMARY KEY,
      headword   TEXT NOT NULL,
      reading    TEXT NOT NULL,
      common     INTEGER NOT NULL,
      freq_rank  INTEGER,
      jlpt       INTEGER,
      senses     TEXT NOT NULL
    );
    CREATE TABLE terms (
      term     TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      kind     TEXT NOT NULL  -- 'kanji' | 'kana'
    );
    CREATE TABLE furigana (
      headword TEXT NOT NULL,
      reading  TEXT NOT NULL,
      segments TEXT NOT NULL,
      PRIMARY KEY (headword, reading)
    );
    CREATE TABLE kanji (
      char     TEXT PRIMARY KEY,
      meanings TEXT NOT NULL,
      on_yomi  TEXT NOT NULL,
      kun_yomi TEXT NOT NULL,
      grade    INTEGER,
      freq     INTEGER,
      strokes  INTEGER
    );
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);

  const jlptIndex = buildJlptIndex();

  console.log('decompressing jmdict…');
  const jmText = await readTgzJson(jmPath);
  console.log('indexing entries…');

  const insEntry = db.prepare(
    'INSERT OR REPLACE INTO entries (id, headword, reading, common, freq_rank, jlpt, senses) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insTerm = db.prepare('INSERT INTO terms (term, entry_id, kind) VALUES (?, ?, ?)');

  let count = 0;
  const insertAll = db.transaction((chunk: string[]) => {
    for (const raw of chunk) {
      const w = JSON.parse(raw) as JmWord;
      const kanjiForms = w.kanji ?? [];
      const kanaForms = w.kana ?? [];
      if (kanaForms.length === 0) continue;

      const headword = kanjiForms[0]?.text ?? kanaForms[0].text;
      const reading = kanaForms[0].text;
      const common =
        kanjiForms.some((k) => k.common) || kanaForms.some((k) => k.common) ? 1 : 0;
      const freqRank = freqRankFrom([
        ...kanjiForms.flatMap((k) => k.tags ?? []),
        ...kanaForms.flatMap((k) => k.tags ?? []),
      ]);

      const senses = (w.sense ?? []).map((s) => ({
        pos: s.partOfSpeech ?? [],
        glosses: (s.gloss ?? []).filter((g) => g.lang === 'eng').map((g) => g.text),
        misc: s.misc ?? [],
        info: s.info ?? [],
      }));
      if (senses.every((s) => s.glosses.length === 0)) continue;

      const jlpt = jlptIndex.get(headword) ?? jlptIndex.get(reading) ?? null;

      insEntry.run(w.id, headword, reading, common, freqRank, jlpt, JSON.stringify(senses));
      const seen = new Set<string>();
      for (const k of kanjiForms) {
        if (seen.has(k.text)) continue;
        seen.add(k.text);
        insTerm.run(k.text, w.id, 'kanji');
      }
      for (const k of kanaForms) {
        if (seen.has(k.text)) continue;
        seen.add(k.text);
        insTerm.run(k.text, w.id, 'kana');
      }
      count++;
    }
  });

  let batch: string[] = [];
  for (const raw of iterArrayObjects(jmText, 'words')) {
    batch.push(raw);
    if (batch.length >= 5000) {
      insertAll(batch);
      batch = [];
      if (count % 50000 < 5000) console.log(`  ${count} entries…`);
    }
  }
  if (batch.length) insertAll(batch);
  console.log(`  ${count} entries indexed`);

  console.log('indexing furigana…');
  const fgText = await readTgzJson(fgPath);
  interface FuriRuby {
    ruby: string;
    rt?: string;
  }
  interface FuriRow {
    text: string;
    reading: string;
    furigana: FuriRuby[];
  }
  const furiRows = JSON.parse(fgText) as FuriRow[];
  const insFuri = db.prepare(
    'INSERT OR REPLACE INTO furigana (headword, reading, segments) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const row of furiRows) {
      const segs = row.furigana.map((f) => ({ text: f.ruby, ruby: f.rt ?? '' }));
      insFuri.run(row.text, row.reading, JSON.stringify(segs));
    }
  })();
  console.log(`  ${furiRows.length} furigana mappings`);

  console.log('indexing kanjidic…');
  const kdText = await readTgzJson(kdPath);
  interface KdChar {
    literal: string;
    misc: { grade: number | null; strokeCounts: number[]; frequency: number | null };
    readingMeaning: {
      groups: {
        readings: { type: string; value: string }[];
        meanings: { lang: string; value: string }[];
      }[];
    } | null;
  }
  const insKanji = db.prepare(
    'INSERT OR REPLACE INTO kanji (char, meanings, on_yomi, kun_yomi, grade, freq, strokes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let kanjiCount = 0;
  const kdBatch: string[] = [];
  for (const raw of iterArrayObjects(kdText, 'characters')) kdBatch.push(raw);
  db.transaction(() => {
    for (const raw of kdBatch) {
      const c = JSON.parse(raw) as KdChar;
      const groups = c.readingMeaning?.groups ?? [];
      const meanings = groups.flatMap((g) =>
        g.meanings.filter((m) => m.lang === 'en').map((m) => m.value),
      );
      const on = groups.flatMap((g) =>
        g.readings.filter((r) => r.type === 'ja_on').map((r) => r.value),
      );
      const kun = groups.flatMap((g) =>
        g.readings.filter((r) => r.type === 'ja_kun').map((r) => r.value),
      );
      if (meanings.length === 0) continue;
      insKanji.run(
        c.literal,
        JSON.stringify(meanings),
        JSON.stringify(on),
        JSON.stringify(kun),
        c.misc?.grade ?? null,
        c.misc?.frequency ?? null,
        c.misc?.strokeCounts?.[0] ?? null,
      );
      kanjiCount++;
    }
  })();
  console.log(`  ${kanjiCount} kanji`);

  console.log('creating indexes…');
  db.exec('CREATE INDEX idx_terms_term ON terms(term)');
  db.exec('CREATE INDEX idx_terms_entry ON terms(entry_id)');
  db.exec('CREATE INDEX idx_entries_common ON entries(common)');
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(
    'built_at',
    new Date().toISOString(),
  );
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('jmdict', jmdict.name);
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();

  const mb = (statSync(DICT_DB).size / 1048576).toFixed(1);
  console.log(`done -> data/dict.db (${mb} MB)`);
}

main().catch((err) => {
  console.error('\ndictionary build failed:', err.message);
  console.error('\nThe app still runs without it, but words will not be glossed.');
  console.error('Retry with:  bun run dict');
  process.exit(1);
});
