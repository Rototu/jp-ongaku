import { useCallback, useMemo } from 'react';
import type { SongWord } from '../../lib/api';
import type { AnalyzedTokenView } from '../../lib/types';
import type { AiChunk } from '../../../../shared/types';
import type { ChunkMastery } from '../../components/ChunkedLine';

/**
 * The song's vocabulary, indexed for lookup from the lyrics.
 *
 * Three ways to find the word behind a piece of the line, tried in that order.
 *
 * Lemma alone is not enough. Words are stored under their dictionary headword,
 * and for kana grammar that headword can be a kanji the song never writes — the
 * possessive の is filed under 乃 — so the surfaces the word was actually seen
 * as carry the match. The reading is the last resort, for chunks the AI split
 * differently from the offline parse.
 */
export function useSongWords(words: SongWord[] | undefined) {
  const wordIndex = useMemo(() => {
    const byKey = new Map<string, SongWord>();
    const byLemma = new Map<string, SongWord>();
    const bySurface = new Map<string, SongWord>();
    for (const w of words ?? []) {
      byKey.set(`${w.lemma}|${w.reading}`, w);
      if (!byLemma.has(w.lemma)) byLemma.set(w.lemma, w);
      for (const surface of w.seenAs) {
        byKey.set(`${surface}|${w.reading}`, w);
        // First writer wins, so the highest-priority word keeps an ambiguous
        // surface: the list arrives ordered by priority.
        if (!bySurface.has(surface)) bySurface.set(surface, w);
      }
    }
    return { byKey, byLemma, bySurface };
  }, [words]);

  /** How well the word behind a chunk is known, for the bar under the text. */
  const masteryOf = useCallback(
    (chunk: AiChunk): ChunkMastery | null => {
      const word =
        wordIndex.byKey.get(`${chunk.text}|${chunk.reading}`) ??
        wordIndex.byLemma.get(chunk.text) ??
        wordIndex.bySurface.get(chunk.text);
      if (!word || !word.enrolled) return null;
      // A retired word carries a full bar and no trouble flag: the user took it
      // out of the rotation, so the lapses behind it are history, not a warning.
      if (word.retired) return { value: 100, trouble: false };
      return { value: word.mastery, trouble: word.lapses >= 3 };
    },
    [wordIndex],
  );

  /** Attaches deck membership to an offline token, for its word panel. */
  const enrich = useCallback(
    (token: AnalyzedTokenView): AnalyzedTokenView => {
      const key = token.entry ? `${token.entry.headword}|${token.entry.reading}` : '';
      const word = key ? wordIndex.byKey.get(key) : undefined;
      return { ...token, wordId: word?.id, inDeck: word?.enrolled };
    },
    [wordIndex],
  );

  return { masteryOf, enrich };
}
