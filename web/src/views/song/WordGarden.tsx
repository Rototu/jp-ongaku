import { useState } from 'react';
import { api, type SongWord } from '../../lib/api';
import { Furigana } from '../../components/Furigana';
import { RubyText } from '../../components/RubyText';
import { Ring, dueLabel } from '../../components/bits';

type Filter = 'deck' | 'song-only' | 'hard' | 'trouble';

/**
 * The word garden: one card per word, with a ring for how well it is stuck.
 *
 * Song-only words are dashed — glossed here, kept out of reviews until added —
 * and the ones worth keeping (N4 and up, common, not yours yet) can be added in
 * one go, because doing that one at a time is what stopped people doing it.
 */
export function WordGarden({ words, onChanged }: { words: SongWord[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>('deck');
  const [busy, setBusy] = useState(false);

  const enrolled = words.filter((w) => w.enrolled);
  const songOnly = words.filter((w) => !w.enrolled);
  const hard = words.filter((w) => (w.jlpt ?? 5) <= 4);
  // Retired words leave the trouble pile: they are no longer coming back to fail.
  const troubled = words.filter((w) => w.lapses >= 3 && !w.retired);
  const worthKeeping = songOnly.filter((w) => (w.jlpt ?? 5) <= 4 || w.priority >= 60);

  const shown =
    filter === 'deck'
      ? enrolled
      : filter === 'song-only'
        ? songOnly
        : filter === 'hard'
          ? hard
          : troubled;

  const add = async (id: number) => {
    await api.enrollWord(id);
    onChanged();
  };

  const addAll = async () => {
    setBusy(true);
    try {
      for (const word of worthKeeping) await api.enrollWord(word.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="garden">
      <div>
        <h3>Words in this song</h3>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {enrolled.length} in your deck · {songOnly.length} not yet. The ring is how well it’s stuck.
        </div>
      </div>

      <div className="chips">
        <button
          className={`chip mono${filter === 'deck' ? ' on' : ''}`}
          onClick={() => setFilter('deck')}
        >
          MY DECK {enrolled.length}
        </button>
        <button
          className={`chip mono${filter === 'song-only' ? ' on' : ''}`}
          onClick={() => setFilter('song-only')}
        >
          SONG-ONLY {songOnly.length}
        </button>
        <button
          className={`chip mono${filter === 'hard' ? ' on' : ''}`}
          onClick={() => setFilter('hard')}
        >
          N4+ {hard.length}
        </button>
        <button
          className={`chip mono bad${filter === 'trouble' ? ' on' : ''}`}
          onClick={() => setFilter('trouble')}
        >
          TROUBLE {troubled.length}
        </button>
      </div>

      {shown.length === 0 && (
        <div className="faint" style={{ fontSize: 13 }}>
          Nothing in this pile yet.
        </div>
      )}

      <div className="garden-grid">
        {shown.slice(0, 40).map((word) => (
          <div
            key={word.id}
            className={`word-card${word.enrolled ? '' : ' songonly'}${
              word.lapses >= 3 && !word.retired ? ' trouble' : ''
            }`}
          >
            <div className="top">
              <span className="term">
                <Furigana segments={word.furigana} />
              </span>
              {word.enrolled ? (
                <Ring value={word.mastery} />
              ) : (
                <span className="tag ink" style={{ fontSize: 9 }}>
                  {word.loanword ? 'カナ' : 'SONG-ONLY'}
                </span>
              )}
            </div>
            <div className="mono faint" style={{ fontSize: 11.5 }}>
              {word.romaji}
            </div>
            <div className="gloss">
              <RubyText text={word.glosses.slice(0, 2).join(' · ')} />
            </div>
            {word.enrolled ? (
              <div className="meta">
                {word.jlpt && <span className="tag jlpt">N{word.jlpt}</span>}
                {word.retired ? (
                  <span className="tag" title="Retired from reviews — counted as known.">
                    RETIRED
                  </span>
                ) : (
                  word.lapses >= 3 && <span className="tag leech">TROUBLE</span>
                )}
                <span className="mono faint" style={{ fontSize: 9.5 }}>
                  {word.retired
                    ? 'no longer reviewed'
                    : (dueLabel(word.dueAt) ?? (word.mastery === 0 ? 'not started' : ''))}
                </span>
              </div>
            ) : (
              <button className="dark small" style={{ alignSelf: 'flex-start' }} onClick={() => add(word.id)}>
                ＋ Add to deck
              </button>
            )}
          </div>
        ))}
      </div>

      {worthKeeping.length > 0 && (
        <div className="bulk-add">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>
              {worthKeeping.length} of these are worth keeping.
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              N4 and above or marked common, and not already in your deck.
            </div>
          </div>
          <button className="primary" onClick={addAll} disabled={busy}>
            {busy ? 'Adding…' : `＋ Add all ${worthKeeping.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
