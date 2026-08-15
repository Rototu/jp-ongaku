import { LlmUnavailable, complete, extractJson } from '../llm/provider';

/**
 * What a YouTube link can tell us about a song.
 *
 * oEmbed is YouTube's own public endpoint for exactly this — title, channel and
 * thumbnail for a public video, no key, no scraping. It carries no duration, so
 * the length comes from the official YouTube Data API when a key is configured:
 * knowing it lets the lyric candidates be ranked by how close their timings are
 * to the recording the user is actually going to play along with. Without a key
 * everything else works and the ranking simply goes without it.
 */

const OEMBED = 'https://www.youtube.com/oembed';
const TIMEOUT_MS = 10_000;
const UA = 'jp-ongaku/0.1 (local Japanese study app)';

export interface YoutubeMeta {
  videoId: string;
  /** The video's title, as uploaded. */
  rawTitle: string;
  channel: string;
  /** From the Data API; null without a key or when it could not be read. */
  durationSec: number | null;
  thumbnailUrl: string | null;
  /** Best guess at the song title, with upload noise removed. */
  title: string;
  /** Best guess at the performer. */
  artist: string;
  /** How the split was reached, so the UI can admit to guessing. */
  guessedBy: 'brackets' | 'separator' | 'channel' | 'ai';
}

export class NotAVideo extends Error {
  constructor() {
    super('that does not look like a YouTube link');
  }
}

/** Extracts a video id from a raw id, a watch URL, a youtu.be or shorts link. */
export function videoIdFrom(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/live\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = p.exec(trimmed);
    if (m) return m[1];
  }
  return null;
}

/** True for input the import field should treat as a video rather than a title. */
export function looksLikeYoutube(input: string): boolean {
  return /youtu\.?be|youtube\.com/i.test(input) && videoIdFrom(input) !== null;
}

/** Bracketed groups carrying only upload noise, which no song is named after. */
const NOISE = [
  'official',
  'music video',
  'video',
  'mv',
  'pv',
  'audio',
  'lyric',
  'lyrics',
  'lyric video',
  'visualizer',
  'full ver',
  'full version',
  'short ver',
  'tv size',
  'tv ver',
  'hd',
  'hq',
  '4k',
  'remaster',
  'remastered',
  'live',
  'teaser',
  'trailer',
  'covered by',
  'cover',
  '歌詞',
  '歌詞付き',
  '公式',
  '公式ミュージックビデオ',
  'ミュージックビデオ',
  'フル',
];

const isNoise = (text: string): boolean => {
  const t = text.toLowerCase().trim();
  if (!t) return true;
  return NOISE.some((n) => t === n || t.startsWith(`${n} `) || t.endsWith(` ${n}`) || t.includes(n));
};

/**
 * Noise that arrives without brackets around it, as a tail or a head.
 *
 * Only stripped at the ends of the title and only as a whole phrase, so a song
 * genuinely called "Music Video" or "Live" keeps its name. Longest first, so
 * "Official Music Video" is not left as "Official" by an eager shorter match.
 */
const NOISE_PHRASES = [
  'official music video',
  'official lyric video',
  'official video',
  'official audio',
  'official mv',
  'music video',
  'lyric video',
  'lyrics video',
  'official',
  'ミュージックビデオ',
  '歌詞付き',
  'mv',
  'pv',
];

/** Drops (…) 【…】 groups that are upload noise, keeping ones that are not. */
function stripNoiseGroups(title: string): string {
  let out = title
    .replace(/[（([【〔]([^)\]】〕）]*)[)\]】〕）]/g, (whole, inner: string) =>
      isNoise(inner) ? ' ' : whole,
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Repeat: uploads stack them ("… Official MV Full ver").
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of NOISE_PHRASES) {
      const tail = new RegExp(`[\\s\\-–—/|・]*${phrase}\\s*$`, 'i');
      const head = new RegExp(`^\\s*${phrase}[\\s\\-–—/|・]+`, 'i');
      const stripped = out.replace(tail, '').replace(head, '').trim();
      if (stripped && stripped !== out) {
        out = stripped;
        changed = true;
      }
    }
  }
  return out;
}

/** Channel names carry their own boilerplate: "LiSA - Topic", "AnimeVEVO". */
function cleanChannel(channel: string): string {
  return channel
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*(official|オフィシャル|公式)(\s*(channel|チャンネル))?$/i, '')
    .replace(/VEVO$/i, '')
    .trim();
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\s'’"“”.,!?・･]/g, '')
    .trim();

/**
 * Splits an upload title into artist and song.
 *
 * Three conventions cover most of what Japanese music uploads look like:
 * 「」 quoting the song around the artist's name, "Artist - Title" (dominant
 * everywhere), and "Title / Artist" (dominant in Japan). Where the channel name
 * matches one side, that side is the artist and no convention has to be guessed.
 */
export function splitTitle(
  rawTitle: string,
  channel: string,
): { title: string; artist: string; guessedBy: YoutubeMeta['guessedBy'] } {
  const cleanTitle = stripNoiseGroups(rawTitle);
  const chan = cleanChannel(channel);

  // Artist「Song」 — and the reverse, 「Song」Artist. 『』 is checked first: where
  // an upload uses both, the double form is the song and the single form is the
  // section it comes from ("… 「Opening」-『Sonare』by TOMOO").
  const quoted = /『([^』]+)』/.exec(cleanTitle) ?? /「([^」]+)」/.exec(cleanTitle);
  if (quoted) {
    const outside = cleanTitle.replace(quoted[0], ' ').replace(/\s{2,}/g, ' ').trim();
    // "… by TOMOO" names the performer, and is worth more than the leftovers.
    const by = /\bby\s+([^|/–—]+)$/i.exec(outside);
    return {
      title: quoted[1].trim(),
      artist: (by ? by[1] : outside).trim() || chan,
      guessedBy: 'brackets',
    };
  }

  for (const sep of [' - ', ' – ', ' — ', ' / ', '／', ' | ', '/']) {
    const at = cleanTitle.indexOf(sep);
    if (at === -1) continue;
    const left = cleanTitle.slice(0, at).trim();
    const right = cleanTitle.slice(at + sep.length).trim();
    if (!left || !right) continue;

    // The channel usually is the artist, and settles which side is which.
    if (chan && normalize(right) === normalize(chan)) {
      return { title: left, artist: right, guessedBy: 'separator' };
    }
    if (chan && normalize(left) === normalize(chan)) {
      return { title: right, artist: left, guessedBy: 'separator' };
    }
    // Otherwise fall back to the convention that matches the separator: a dash
    // reads "Artist - Title", a slash reads "Title / Artist".
    const slash = sep.includes('/') || sep.includes('／');
    return slash
      ? { title: left, artist: right, guessedBy: 'separator' }
      : { title: right, artist: left, guessedBy: 'separator' };
  }

  return { title: cleanTitle, artist: chan, guessedBy: 'channel' };
}

/**
 * A split that came out looking wrong.
 *
 * Real uploads stack more than the conventions allow for — "Show Name Full
 * Opening 2 Lyrics | Song | Artist" has three segments and the rules above take
 * the first as the artist. The tells are a section name where a song should be, a
 * side still carrying separators or a "by", or either side being too long to be
 * anyone's name. Any of them and the model gets a turn.
 */
function looksUnsure(split: { title: string; artist: string }): boolean {
  const { title, artist } = split;
  if (!title.trim()) return true;
  if (title.length > 40 || artist.length > 40) return true;
  if (/[|/／–—]|\bby\b|\bfeat\.?\b|\bft\.?\b/i.test(artist)) return true;
  // A section of a show, not a song: the real title is elsewhere in the upload.
  if (/^(opening|ending|op|ed|full|lyrics?|theme)\s*\d*$/i.test(title.trim())) return true;
  return false;
}

/**
 * Asks the model to split a title the patterns above could not.
 *
 * Uploads like "YOASOBI アイドル Official" have no separator at all, and the
 * model knows which half is the band. Returns null whenever the AI layer is off
 * or the answer is unusable, so this can never be the reason an import fails.
 */
async function refineWithAi(
  rawTitle: string,
  channel: string,
): Promise<{ title: string; artist: string } | null> {
  try {
    const text = await complete(
      `YouTube video title: ${JSON.stringify(rawTitle)}\n` +
        `Channel: ${JSON.stringify(channel)}\n\n` +
        'Return only JSON: {"title": "song title", "artist": "performer"}.\n' +
        '- The title is the song, never the show it is from and never a section of it ' +
        '("Opening", "OP2", "Ending").\n' +
        '- The artist is the person or band performing, not the anime and not the uploader.\n' +
        '- Keep the original script — do not translate or romanise. Where the upload gives ' +
        'both a Japanese and a romanised title, use the Japanese one.\n' +
        '- Drop upload noise like "Official MV", "Full Lyrics" or "歌詞付き".',
      'You extract song metadata from video titles. You reply with JSON and nothing else.',
    );
    const parsed = extractJson<{ title?: unknown; artist?: unknown }>(text);
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const artist = typeof parsed.artist === 'string' ? parsed.artist.trim() : '';
    if (!title) return null;
    return { title, artist };
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) {
      console.error('[youtube] title refinement failed:', err);
    }
    return null;
  }
}

/**
 * Ways to ask a lyrics database about this video, best first.
 *
 * One query is not enough in practice. Uploads write a title as "Sonare
 * (ソナーレ)" where the database has it as "Sonare"; they name the show around the
 * song; the channel is not always the artist the song is filed under. Each
 * candidate drops one of those assumptions, so the search can widen only as far
 * as it has to.
 */
export function searchCandidates(video: {
  title: string;
  artist: string;
  rawTitle: string;
}): { q: string; artist?: string }[] {
  const out: { q: string; artist?: string }[] = [];
  const push = (q: string, artist?: string) => {
    const query = q.trim();
    if (!query) return;
    if (out.some((c) => c.q === query && c.artist === artist)) return;
    out.push({ q: query, artist });
  };

  const artist = video.artist.trim() || undefined;
  const bare = video.title.replace(/[（(][^)）]*[)）]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // The parenthetical is often the Japanese spelling of the same title, which is
  // the one worth searching when the romanisation finds nothing.
  const inner = /[（(]([^)）]+)[)）]/.exec(video.title)?.[1]?.trim();

  push(video.title, artist);
  push(video.title);
  if (bare !== video.title) {
    push(bare, artist);
    push(bare);
  }
  if (inner) {
    push(inner, artist);
    push(inner);
  }
  push(video.rawTitle);
  return out;
}

interface OembedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

/**
 * ISO-8601 duration, as the Data API reports it — "PT4M13S", "PT1H2M3S",
 * "P1DT3H" for the very long ones — in seconds. Null for anything else.
 */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

/** Runtime in seconds from the Data API. Null without a key or on any failure. */
async function durationOf(videoId: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails` +
        `&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      items?: { contentDetails?: { duration?: string } }[];
    };
    const iso = body.items?.[0]?.contentDetails?.duration;
    return iso ? parseIsoDuration(iso) : null;
  } catch {
    // Best effort only: without it the candidates are ranked without duration.
    return null;
  }
}

/**
 * Everything a YouTube link gives us about the song it plays.
 *
 * The AI refinement is attempted only where the deterministic split gave up
 * (no separator, no quotes), so a working import never waits on a model call it
 * does not need.
 *
 * `apiKey`, when given, unlocks the duration lookup; without it the resolve is
 * still complete except for `durationSec`.
 */
export async function resolve(
  input: string,
  opts: { apiKey?: string | null } = {},
): Promise<YoutubeMeta> {
  const videoId = videoIdFrom(input);
  if (!videoId) throw new NotAVideo();

  const url = `${OEMBED}?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error('YouTube would not describe that video — it may be private or deleted');
  }
  if (!res.ok) throw new Error(`YouTube responded ${res.status}`);

  const meta = (await res.json()) as OembedResponse;
  const rawTitle = (meta.title ?? '').trim();
  const channel = (meta.author_name ?? '').trim();
  if (!rawTitle) throw new Error('YouTube returned no title for that video');

  const [split, durationSec] = await Promise.all([
    (async () => {
      const guess = splitTitle(rawTitle, channel);
      if (guess.guessedBy !== 'channel' && !looksUnsure(guess)) return guess;
      const refined = await refineWithAi(rawTitle, channel);
      return refined
        ? { title: refined.title, artist: refined.artist || guess.artist, guessedBy: 'ai' as const }
        : guess;
    })(),
    opts.apiKey ? durationOf(videoId, opts.apiKey) : null,
  ]);

  return {
    videoId,
    rawTitle,
    channel,
    durationSec,
    thumbnailUrl: meta.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    title: split.title,
    artist: split.artist,
    guessedBy: split.guessedBy,
  };
}
