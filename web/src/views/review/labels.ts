import type { CardKind, CardReasonKind } from '../../../../shared/types';
import type { ReviewOptions } from '../Review';

export function sessionLabel(options: ReviewOptions): string {
  if (options.leeches) return 'TROUBLE DRILL';
  if (options.songId) return 'THIS SONG';
  if (options.kinds?.length) return options.kinds.join(' + ').toUpperCase();
  return 'MIXED REVIEW';
}

export function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return 'st';
  if (n % 10 === 2 && n % 100 !== 12) return 'nd';
  if (n % 10 === 3 && n % 100 !== 13) return 'rd';
  return 'th';
}

export function kindLabel(kind: CardKind): string {
  const labels: Record<CardKind, string> = {
    vocab: 'vocabulary',
    grammar: 'grammar',
    cloze: 'fill the blank',
    listening: 'listening',
    kana: 'katakana',
    kanji: 'kanji',
  };
  return labels[kind] ?? kind;
}

export const REASONS: { key: CardReasonKind; label: string }[] = [
  { key: 'looks-like-another', label: 'Looks like another word' },
  { key: 'cannot-hear', label: 'Can’t hear the difference' },
  { key: 'meaning', label: 'Meaning won’t stick' },
  { key: 'reading', label: 'Reading won’t stick' },
];
