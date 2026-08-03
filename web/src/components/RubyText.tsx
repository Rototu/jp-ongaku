import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { FuriganaSegment } from '../../../shared/types';
import { api } from '../lib/api';
import { Furigana } from './Furigana';

/**
 * Prose that may quote Japanese, rendered with ruby over every kanji.
 *
 * Explanations, grammar notes and model answers are written in English but
 * quote the word they are about — "the 已然形 of 見回す". Everything else in the
 * app annotates its Japanese; text that came from a model or from the
 * dictionary did not, so it arrived as bare kanji in the middle of a sentence
 * the user could otherwise read.
 *
 * The readings need the tokenizer and the dictionary, both of which live on the
 * server, so the strings are sent there in a batch and cached on both sides.
 * Until the answer arrives the text renders plain: the sentence is readable
 * either way, and ruby appearing a moment later is better than a blank.
 *
 * Inside a song, the song's own readings win. A note explaining 埋葬る has to say
 * うめる, the reading in the lyrics a line above it, not the dictionary's まいそう —
 * one word cannot carry two readings on one screen, and the wrong one was landing
 * in the sentence doing the explaining. `SongReadings` marks that scope.
 */

/** Which song's readings quoted Japanese should be annotated against. */
const SongReadingsContext = createContext<number | null>(null);

export function SongReadings({ songId, children }: { songId: number; children: ReactNode }) {
  return <SongReadingsContext.Provider value={songId}>{children}</SongReadingsContext.Provider>;
}
export function RubyText({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  const songId = useContext(SongReadingsContext);
  const segments = useRuby(text, songId);
  if (!text) return null;
  if (!segments) return <span className={className}>{text}</span>;
  return <Furigana segments={segments} className={['ruby-text', className].filter(Boolean).join(' ')} />;
}

/** Segments for `text`, or null while they are unknown or unnecessary. */
function useRuby(text: string | null | undefined, songId: number | null): FuriganaSegment[] | null {
  // Cached per song, since the same words read differently from song to song.
  const key = text && KANJI.test(text) ? `${songId ?? ''}\u0000${text}` : '';
  const [segments, setSegments] = useState<FuriganaSegment[] | null>(() => lookup(key));

  useEffect(() => {
    if (!key) {
      setSegments(null);
      return;
    }
    const hit = lookup(key);
    if (hit) {
      setSegments(hit);
      return;
    }
    let cancelled = false;
    setSegments(null);
    void annotate(text as string, songId).then((segs) => {
      if (!cancelled) setSegments(segs);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return segments;
}

const KANJI = /[㐀-䶿一-鿿豈-﫿々]/;

const cache = new Map<string, FuriganaSegment[]>();
const inflight = new Map<string, Promise<FuriganaSegment[]>>();

function lookup(key: string): FuriganaSegment[] | null {
  return key ? (cache.get(key) ?? null) : null;
}

interface Waiting {
  text: string;
  songId: number | null;
  resolve: (segments: FuriganaSegment[]) => void;
}

let pending: Waiting[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * One request per burst of strings. A panel opening asks for a dozen of them in
 * the same tick — a meaning, an explanation, a handful of notes — and they all
 * travel together.
 */
function annotate(text: string, songId: number | null): Promise<FuriganaSegment[]> {
  const key = `${songId ?? ''}\u0000${text}`;
  const running = inflight.get(key);
  if (running) return running;

  const promise = new Promise<FuriganaSegment[]>((resolve) => {
    pending.push({ text, songId, resolve });
    if (!timer) timer = setTimeout(flush, 16);
  });
  inflight.set(key, promise);
  return promise;
}

const BATCH_LIMIT = 200; // matches the server's cap

async function flush(): Promise<void> {
  timer = null;
  const batch = pending.slice(0, BATCH_LIMIT);
  pending = pending.slice(BATCH_LIMIT);
  if (pending.length > 0) timer = setTimeout(flush, 16);

  // One request per song scope: each carries its own reading map on the server.
  const bySong = new Map<number | null, Waiting[]>();
  for (const item of batch) {
    const group = bySong.get(item.songId);
    if (group) group.push(item);
    else bySong.set(item.songId, [item]);
  }

  await Promise.all(
    [...bySong.entries()].map(async ([songId, group]) => {
      const texts = [...new Set(group.map((b) => b.text))];
      let segments: Record<string, FuriganaSegment[]> = {};
      try {
        segments = (await api.furigana(texts, songId ?? undefined)).segments;
      } catch {
        // A failed annotation is not worth surfacing: the caller falls back to
        // the plain text it already has.
      }
      for (const { text, resolve } of group) {
        const segs = segments[text] ?? [{ text, ruby: '' }];
        const key = `${songId ?? ''}\u0000${text}`;
        cache.set(key, segs);
        inflight.delete(key);
        resolve(segs);
      }
    }),
  );
}
