import type { GrammarNote, Token } from '../../../shared/types';

/**
 * Token as the server sends it: the shared Token plus the chunk extras the
 * analyzer attaches, and two client-side flags the views fill in.
 */
export interface AnalyzedTokenView extends Token {
  grammar: GrammarNote[];
  functionGloss?: string;
  parts: string[];
  /** Filled in by the song view once the word list is loaded. */
  wordId?: number;
  inDeck?: boolean;
}
