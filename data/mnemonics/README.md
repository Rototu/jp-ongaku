# Kanji mnemonics

A memory hook for the meaning and a memory hook for the sound, for every kanji in
KANJIDIC2 — around ten thousand characters, not just the 2,136 jōyō.

Two hooks per character, in the WaniKani mould:

```json
{"char":"語","meaning":"A mouth (口) speaking words (言) five (五) times over — talking, again and again, is language.","reading":"GO! Shout \"go\" and start talking — every language begins the moment you say GO.","readingKey":"ゴ","components":["言","口","五"]}
```

| Field | |
|---|---|
| `char` | the character |
| `meaning` | how to remember what it means, built from the parts in `components` |
| `reading` | how to remember how it sounds, built around `readingKey` |
| `readingKey` | the reading the sound hook uses, in kana. Empty when the model named one the character does not actually have — the hook is kept, the false claim is not |
| `components` | what the character is written with, from KRADFILE |

One JSON object per line, sorted by codepoint. It is a text file on purpose: a
diff shows exactly which hooks changed, and the set can be used by anything that
can read a line at a time.

## Why the components matter

Mnemonics only compound if the parts are called the same thing every time — 言 has
to be "say" in 語 and in 話 and in 訳, or each hook starts from nothing. So the
characters are covered simplest-first, and each request is told the names already
given to the parts it contains. That ordering is the whole reason this exists as a
built artifact rather than as something generated per word on demand.

## Regenerating

From the repository root:

```bash
bun run mnemonics                 # cover whatever is still missing
bun run mnemonics --only 語話訳    # specific characters
bun run mnemonics --force         # rewrite hooks that already exist
bun run mnemonics --compile       # rebuild the read cache, no model calls
```

The run is resumable: each batch is appended as it lands, so an interruption
costs at most the batches in flight, and starting again skips what is covered.
`meta.json` records which model wrote the current set.

Consuming it needs no model and no build step — read the JSONL directly, or let
`server/mnemonics.ts` compile it into `data/mnemonics.db` for indexed lookups.

## Provenance and licensing

Character data, readings and meanings come from **KANJIDIC2** (CC BY-SA 4.0) and
component decomposition from **KRADFILE** (EDRDG licence), both via
[scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified).
Attribution for both belongs to the
[Electronic Dictionary Research and Development Group](https://www.edrdg.org/edrdg/licence.html).

The hook text itself is generated, and is not derived from any existing mnemonic
set — not WaniKani, not KanjiDamage, not Remembering the Kanji. Those are all
either proprietary or unlicensed, which is why this file exists at all.

Being generated, the hooks are uneven. Some are vivid and some are flat, a few
lean on a reading that is real but rare, and none have been checked by a human
teacher. Each one is checked mechanically for two things only: that the reading it
names is one the character actually has, and that the sound-alike visibly contains
that sound.
