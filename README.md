# jp-ongaku ♪

A local app for learning Japanese from song lyrics. Type a song title, get a full
lesson: every line broken into words with **furigana and romaji always on**,
dictionary meanings, grammar notes, and a flashcard deck that drills whatever you
keep forgetting.

Everything runs and stays on your machine. No account, no cloud, no telemetry.

---

## Quick start

```bash
bun install
```

```bash
bun run dict
```

```bash
bun run start
```

Then open <http://localhost:5272>.

The `dict` step downloads and indexes the open dictionaries (JMdict, JmdictFurigana,
KANJIDIC2) into `data/dict.db` — about 115 MB, one time only. Re-running it is
cheap; the downloads are cached in `data/raw/`.

For development with hot reload:

```bash
bun run dev
```

That serves the UI on <http://localhost:5273> and proxies the API to 5272.

---

## How a lesson gets built

1. **Lyrics.** You type a title; the app searches [LRCLIB](https://lrclib.net), an
   open crowdsourced lyrics API. Japanese-script results with time-synced lyrics
   rank first, because synced lyrics give karaoke playback for free. If nothing
   good turns up, paste the lyrics yourself — the paste box also accepts `.lrc`
   files with timestamps.
2. **Local parse.** `kuromoji` tokenises each line, then inflectional tails are
   merged back into single study units: `探し + て + いる` becomes **探している**
   with dictionary form 探す. Case particles (は/が/を/の) stay separate, because
   those are what show sentence structure. Readings come from JmdictFurigana's
   curated kanji↔reading alignment; meanings from JMdict, with homograph
   disambiguation and archaic entries ranked down. Particles get hand-written
   grammar glosses rather than dictionary homographs — 「は」 is "topic marker",
   not "tooth".
3. **AI analysis.** Where a model is available it takes over segmentation,
   readings and explanations, because morphology alone cannot tell 今日 きょう
   from こんにち by context, decode a contraction, or recognise the set
   expressions songs are built from. Each line comes back as coloured chunks —
   one per word or expression — each with its own reading, romaji, role, meaning
   and explanation, plus a translation and a literal gloss for the whole line.
   This starts automatically on import.
4. **Cards.** Vocabulary, grammar patterns, fill-the-blank cloze on real lines, and
   listening clips when a video is attached.

### Correctness guardrails

You said you'd rather be slow than learn something wrong, so the AI layer is
fenced in rather than trusted:

- **Reconstruction check.** The chunks a model returns must concatenate back to
  the exact original line, character for character. A dropped, invented,
  reordered or "corrected" word fails the whole line — it never reaches you.
- **One retry, then fall back.** A rejected segmentation is re-requested with an
  explicit correction. If it fails again, the line keeps its offline parse and the
  UI says how many lines that happened to.
- **Readings are checked against JMdict.** Every reading is marked verified,
  unverified, or unknown. An unverified reading — one the dictionary doesn't carry
  for those characters — gets a dotted underline, so a surprising reading is
  visible instead of taken on faith. Songs do use irregular readings deliberately,
  so this is a flag, not an error.
- **Furigana is always aligned locally** from the reading. Ruby markup is never
  taken from the model, where a mis-split would land readings on the wrong kanji.
- **Translations survive rejected segmentation.** A line can have a good
  translation and an untrusted word breakdown; those are stored independently.

Analysis is cached per line, so re-opening a song costs nothing and a re-run only
processes what's missing.

---

## What's in the app

| Screen | What it does |
| --- | --- |
| **Today** | Answers "what now" in one glance: a three-track setlist — kana warm-up, the cards actually due, the next unfinished section of the song you care most about — with a time estimate and one button. Plus what you're in the middle of, and the pair of things you keep confusing. |
| **Songs** | One field to add anything: type a title and the video link, AI notes and paste-the-lyrics-yourself box are "＋" chips behind it. The library is cards, each with one bar per stretch of lines, darker where the lines are better known. Star a song and its sections lead the setlist. |
| **Song view** | A sticky stage bar (video, scrub with section marks, play, study) over the lyrics. Colour is what a word *does*; the bar underneath is how well you know it. Tap any piece for its own explanation, generated examples and a question box. Sections are a spine in the rail; vocabulary is a garden of cards with mastery rings, and the ones worth keeping add in bulk. |
| **Stage mode** | `⇧S` from any song. The chrome drops, one line fills the screen, loop ×3 keeps the same phrase coming back, and hovering a word pauses playback to show its meaning and the kanji behind it. Optional microphone meter counts the lines you actually sang. |
| **Review** | One card at a time, keyboard-driven, mixed card types interleaved. Each grade button says what it will do to the schedule. After a third miss the card asks what is going wrong, and the answer shows up on Today next to the drill it changed. |
| **Progress** | Four numbers that matter, then the song map: every line of every song as one cell, shaded by how well it is known. Below it, the pairs that keep tripping you up and the lines worth replaying. |
| **Settings** | Pick the AI backend, see exactly what is stored where. |

Everything that isn't Play or Study lives in **⌘K**: jump to a song, start a drill,
re-explain the lines, re-time them, fix a title reading, toggle romaji.

### Card types

- **Vocabulary** — word → meaning, with reading and romaji.
- **Grammar** — what a pattern does, shown against a real line from a song.
- **Cloze** — a line with one word blanked, four plausible choices.
- **Listening** — the clip for one line plays, then you reveal the text. Needs a
  YouTube link plus timings.
- **Katakana** — 113 recognition cards including the classic look-alikes
  (シ/ツ, ソ/ン, ク/ワ/タ). Seed it from the Today screen.

### Spaced repetition

Classic SM-2. Quality 0–5, mapped to four buttons: Again / Hard / Good / Easy
(keys `1`–`4`, `space` reveals). Failing resets the interval and the card returns
in ten minutes. Three lapses flags a card as a **leech**, which pushes it to the
front of the queue and into the trouble drill.

### Which words enter the deck

Not all of them, on purpose. Songs are full of rare poetic vocabulary you will
never meet again. Each word gets a 0–100 priority from JMdict frequency data, the
`common` flag, and JLPT level; at 40 or above it enrolls automatically. Everything
below stays fully glossed and browsable, marked **song-only**, and you can add any
of it with one click.

### The player

The video keeps YouTube's own controls, and the app reads playback state from the
player rather than from its own buttons — so starting or pausing inside the frame
moves the app's state too. One toggle shows what is actually happening (filled =
playing), a progress bar under the video scrubs by click or drag (arrow keys move
5s when focused), and clicking the picture plays or pauses. The bottom strip of
the frame is left alone so YouTube's scrubber, captions and fullscreen still work.

### Sing-along and timings

Attach a YouTube link to a song. If LRCLIB supplied synced lyrics, lines highlight
in time immediately. If not, hit **Tap to time the lines** and press `space` as
each line starts — timings save locally and unlock listening cards.

### Titles

Song titles are coined names whose readings no parser can derive: the tokenizer
reads 紅蓮華 as 紅蓮 + 華 ("guren hana") when the real reading is *gurenge*. The
automatic guess is shown, and **fix reading** lets you type the real one in kana or
romaji.

---

## The AI layer

One transport: **Vercel AI Gateway** over HTTP. Paste a key in Settings — it is
stored in `data/ongaku.db` and never sent back to the browser — and set any model
id the gateway accepts. Because every provider sits behind the same endpoint,
changing model is a settings change, not a code change.

Turn it off (or leave the key out) and the app is dictionary-only: readings,
romaji, furigana, meanings, all card types and the whole SRS still work. What you
lose is coloured chunking, natural translations, per-line grammar commentary, and
mnemonics.

**Model choice matters here.** Segmentation and readings are the part that has to
be right, and a weak model gets its segmentation rejected more often, which costs
retries — so a stronger model is frequently no slower end to end. Cheap models on
the gateway's free tier are also rate-limited, and a 34-line song is ~6 requests.

**Your own context.** Import (and the song page) has a collapsed *Extra context
for the AI* box: paste an interview, a plot summary, who is singing to whom. It is
stored with the song and handed to the model whenever it explains a line, a word
or an example — as background, never as text to translate. Songs whose meaning
lives outside their words are the ones this fixes. Editing it afterwards affects
new explanations; use **Re-explain lines** to redo the ones already done.

**Examples and questions, on demand.** Tapping a word gives *Generate usage
examples* — three short sentences using it in the same sense, each with furigana
and romaji built by the local tokenizer — and *Ask something about this* for
anything else. Both are stored in `data/ongaku.db` against the word itself, so the
same word costs one request ever: reopening it, in this song or another, reads the
cache, and an identical question is answered from it rather than re-asked.

Analysis runs in the background and the song view shows a live progress bar; lines
appear as they finish. Failures never damage a lesson: finished lines stay saved,
`Retry-After` is honoured, and re-running resumes from where it stopped. Errors
name the actual cause — bad key, unknown model, rate limit — and quote the
gateway's own message. Set the `auto_analyze` setting to `off` if you'd rather
trigger analysis by hand.

---

## Kanji mnemonics

Every kanji in the dictionary — around ten thousand characters, not just the 2,136
jōyō — ships with two memory hooks: one for what it means, built from the parts it
is written with, and one for how it sounds, built around a reading it actually has.

They are generated once into `data/mnemonics/kanji-mnemonics.jsonl` and read from
there, so tapping a word costs nothing and works offline. Nothing needs building
after a clone: the JSONL is compiled into an indexed cache the first time it is
read, and a character the artifact somehow misses is still written on demand.

The reason this is a built artifact rather than something generated per word is
consistency. Hooks only compound if the parts are named the same way every time —
言 has to be "say" in 語 and in 話 and in 訳 — so characters are covered
simplest-first and each request is told what its parts have already been called.
A single word tap has no way to know that.

```bash
bun run mnemonics              # cover whatever is still missing
bun run mnemonics --only 語話訳 # specific characters
bun run mnemonics --compile    # rebuild the read cache, no model calls
```

Being generated, the hooks are uneven, and none have been reviewed by a human
teacher. Two things are checked mechanically: that the reading a hook names is one
the character really has, and that the sound-alike visibly contains that sound.
See [data/mnemonics/README.md](data/mnemonics/README.md) for the format and the
licensing of what it was built from.

---

## Your data

| File | Contents |
| --- | --- |
| `data/ongaku.db` | Your songs, lines, cards, review history, settings. **Copy this one file to back everything up.** |
| `data/dict.db` | The dictionaries. Rebuildable any time with `bun run dict`. |
| `data/mnemonics/` | The kanji mnemonic artifact — a hook for the meaning and one for the sound, for every character. Text, versioned, [documented on its own](data/mnemonics/README.md). |
| `data/mnemonics.db` | Read cache compiled from that artifact. Deleting it costs nothing; it rebuilds itself. |
| `data/raw/` | Cached dictionary downloads. Safe to delete. |

Lyrics you import are stored locally for your own study and are never uploaded
anywhere.

**The microphone**, if you turn on shadowing in stage mode, is read through the
browser's analyser and nothing else: no audio is recorded, stored or sent. All the
app derives from it is whether there was sound while a line was on screen.

**One network call for looks.** The UI asks Google Fonts for its typefaces
(Bricolage Grotesque, Plus Jakarta Sans, JetBrains Mono, Zen Maru Gothic, Noto Sans
JP). Every stack falls back to a system font, so offline the app still reads
correctly — delete the `<link>` tags in `web/index.html` if you would rather it
made no outbound request at all.

---

## Layout

```
server/
  nlp/        tokenizer, furigana alignment, romaji, priority scoring, grammar patterns
  lyrics/     LRCLIB client, LRC parsing, verse grouping
  lesson/     lesson builder, katakana deck, title annotation
  srs/        SM-2 scheduler, queue, stats, trouble reports
  llm/        provider adapter and the explanation layer
  routes/     the HTTP API
web/          React UI
shared/       types used by both sides
test/         186 tests
```

```bash
bun test
```

```bash
bun run typecheck
```

---

## Keyboard

| Key | Action |
| --- | --- |
| `space` | reveal the answer (or tap a line's timing while syncing) |
| `1` `2` `3` `4` | Again / Hard / Good / Easy |
| `r` | replay a listening clip |
| `esc` | cancel timing mode |

---

## Credits

Built on open data: [JMdict/EDICT](https://www.edrdg.org/jmdict/edict_doc.html) and
KANJIDIC2 by the Electronic Dictionary Research and Development Group (Creative
Commons Attribution-ShareAlike), [jmdict-simplified](https://github.com/scriptin/jmdict-simplified),
[JmdictFurigana](https://github.com/Doublevil/JmdictFurigana),
KRADFILE (EDRDG licence, for kanji component decomposition),
[kuromoji](https://github.com/takuyaa/kuromoji.js),
[wanakana](https://wanakana.com), and [LRCLIB](https://lrclib.net).

Teaching approach owes a debt to [m98/fluent](https://github.com/m98/fluent):
active recall, spaced repetition, immediate feedback, and letting recorded mistakes
drive what gets drilled.
