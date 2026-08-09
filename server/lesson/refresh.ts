import { getDb, getSetting, setSetting } from '../db';
import { rebuildLesson } from './build';

/**
 * Re-runs the lesson builder over songs imported before its current behaviour.
 *
 * Card faces are derived data — the dictionary entry a word resolves to, the
 * meaning printed under a cloze answer, whether a negative form is marked as one
 * — and every fix to that derivation used to reach only songs imported after it.
 * A library imported last week kept asking about 菊 "chrysanthemum" for きいて and
 * glossing 見えない as "to be visible".
 *
 * The pass is gated on a recorded generation, so it runs once per change rather
 * than on every boot. Bump `BUILD_GENERATION` whenever the builder's output
 * changes for lyrics it has already seen.
 */
const BUILD_GENERATION = '2';

const SETTING_KEY = 'lesson_build_generation';

export interface RefreshResult {
  songs: number;
  cardsCreated: number;
  cardsPruned: number;
}

export async function refreshLessons(force = false): Promise<RefreshResult | null> {
  if (!force && getSetting(SETTING_KEY) === BUILD_GENERATION) return null;

  const songs = getDb().query<{ id: number }, []>('SELECT id FROM songs ORDER BY id').all();

  let cardsCreated = 0;
  let cardsPruned = 0;
  let rebuilt = 0;

  for (const song of songs) {
    // One song failing — a line the tokenizer chokes on — should not stop the
    // rest of the library from being brought up to date.
    try {
      const result = await rebuildLesson(song.id);
      if (!result) continue;
      cardsCreated += result.cardsCreated;
      cardsPruned += result.cardsPruned;
      rebuilt++;
    } catch (err) {
      console.error(`[lessons] rebuild of song ${song.id} failed:`, err);
    }
  }

  setSetting(SETTING_KEY, BUILD_GENERATION);
  return { songs: rebuilt, cardsCreated, cardsPruned };
}
