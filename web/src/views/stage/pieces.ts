import type { AiChunk, SongLine } from '../../../../shared/types';

/** One renderable piece of a line: AI chunks when they exist, tokens otherwise. */
export interface StagePiece {
  text: string;
  romaji: string;
  furigana: { text: string; ruby: string }[];
  role: string;
  meaning: string;
  explanation: string;
}

export function renderable(line: SongLine | null): StagePiece[] {
  if (!line) return [];
  const chunks = line.analysis?.chunks ?? [];
  if (chunks.length > 0) {
    return chunks.map((chunk: AiChunk) => ({
      text: chunk.text,
      romaji: chunk.romaji,
      furigana: chunk.furigana.length > 0 ? chunk.furigana : [{ text: chunk.text, ruby: '' }],
      role: chunk.role,
      meaning: chunk.meaning,
      explanation: chunk.explanation,
    }));
  }
  return line.tokens
    .filter((token) => !token.filler)
    .map((token) => ({
      text: token.surface,
      romaji: token.romaji,
      furigana: token.furigana.length > 0 ? token.furigana : [{ text: token.surface, ruby: '' }],
      role: token.pos,
      meaning: token.entry?.senses[0]?.glosses.slice(0, 2).join('; ') ?? '',
      explanation: '',
    }));
}

export function lineFurigana(line: SongLine | undefined): { text: string; ruby: string }[] {
  if (!line) return [];
  const chunks = line.analysis?.chunks ?? [];
  if (chunks.length > 0) return chunks.flatMap((c) => c.furigana);
  return line.tokens.flatMap((t) =>
    t.furigana.length > 0 ? t.furigana : [{ text: t.surface, ruby: '' }],
  );
}
