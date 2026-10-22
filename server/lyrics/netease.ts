import type { LyricProvider } from './providers';
import { NotFound, type LyricRecord } from './rank';

/**
 * NetEase Cloud Music (music.163.com), through the public endpoints its web
 * player calls.
 *
 * It carries timed lyrics for a large share of anime and J-pop releases that
 * LRCLIB lacks. The API is unofficial and, like LRCLIB, holds no publisher
 * licence for the words; see docs/distribution-and-licensing.md.
 */

const BASE = 'https://music.163.com/api';
const HEADERS = {
  'User-Agent': 'jp-ongaku/0.1 (local Japanese study app)',
  Referer: 'https://music.163.com',
  Accept: 'application/json',
};
const TIMEOUT_MS = 15_000;
/** Search returns metadata only, so each result costs one more request. */
const HYDRATE_LIMIT = 8;

interface ApiSong {
  id: number;
  name: string;
  artists: { name: string }[];
  album: { name: string } | null;
  /** Milliseconds. */
  duration: number;
}

const KANA_RE = /[぀-ゟ゠-ヿ]/;

/**
 * Credit lines NetEase prepends to the body, timed at the start like lyrics:
 * `[00:00.000] 作词 : LiSA`. Left in, they would become the first study line.
 */
const CREDIT_RE =
  /^\[[\d:.]+\]\s*(作词|作曲|编曲|作詞|編曲|词|曲|制作人|製作人|监制|混音|母带|和声|录音|出品|Lyrics|Music|Arrange[rd]?)\s*[:：]/i;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NetEase responded ${res.status}`);
  return (await res.json()) as T;
}

/** The timed body with credit lines removed, or null when there is none. */
async function lyricsFor(id: number): Promise<string | null> {
  const res = await get<{ lrc?: { lyric?: string } }>(`/song/lyric?id=${id}&lv=1`);
  const body = (res.lrc?.lyric ?? '')
    .split('\n')
    .filter((line) => !CREDIT_RE.test(line.trim()))
    .join('\n')
    .trim();
  return body || null;
}

/**
 * NetEase is mostly a Chinese catalogue, and Chinese lyrics pass a kanji-based
 * Japanese check. Japanese lyrics all but always contain kana, so require it.
 */
function toRecord(song: ApiSong, lyrics: string | null): LyricRecord | null {
  if (!lyrics || !KANA_RE.test(lyrics)) return null;
  return {
    provider: 'netease',
    id: song.id,
    trackName: song.name,
    artistName: song.artists.map((a) => a.name).join(', '),
    albumName: song.album?.name || null,
    duration: song.duration ? song.duration / 1000 : null,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: lyrics,
  };
}

async function search(query: string, artist?: string): Promise<LyricRecord[]> {
  const s = artist ? `${query} ${artist}` : query;
  const res = await get<{ result?: { songs?: ApiSong[] } }>(
    `/search/get?s=${encodeURIComponent(s)}&type=1&limit=${HYDRATE_LIMIT}`,
  );
  const songs = res.result?.songs ?? [];
  const bodies = await Promise.allSettled(songs.map((song) => lyricsFor(song.id)));
  return songs.flatMap((song, i) => {
    const body = bodies[i];
    const record = body.status === 'fulfilled' ? toRecord(song, body.value) : null;
    return record ? [record] : [];
  });
}

async function getById(id: number): Promise<LyricRecord> {
  const res = await get<{ songs?: ApiSong[] }>(`/song/detail?ids=%5B${id}%5D`);
  const song = res.songs?.[0];
  if (!song) throw new NotFound();
  const record = toRecord(song, await lyricsFor(id));
  if (!record) throw new NotFound();
  return record;
}

export const netease: LyricProvider = {
  id: 'netease',
  label: 'NetEase',
  search,
  get: getById,
};
