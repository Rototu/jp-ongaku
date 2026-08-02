import { useEffect, useState } from 'react';
import type { AnalyzedTokenView } from '../lib/types';
import { api, type KanjiInfo } from '../lib/api';
import { Furigana } from './Furigana';
import { RubyText } from './RubyText';
import { WordExtras } from './WordExtras';

/**
 * Side panel shown when a word in the lyrics is clicked: readings, romaji,
 * every dictionary sense, grammar carried by the chunk, and the kanji inside it
 * broken down character by character — then generated examples and a question
 * box for whatever the dictionary does not answer.
 */
export function WordPanel({
  token,
  onClose,
  onEnrolled,
  lineText,
  songId,
}: {
  token: AnalyzedTokenView;
  onClose: () => void;
  onEnrolled?: () => void;
  /** The line the word was tapped in, passed to the AI for context. */
  lineText?: string;
  songId?: number;
}) {
  const [kanji, setKanji] = useState<KanjiInfo[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [enrolled, setEnrolled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setKanji([]);
    api
      .lookup(token.surface)
      .then((res) => {
        if (!cancelled) setKanji(res.kanji);
      })
      .catch(() => {
        /* the panel is still useful without kanji details */
      });
    return () => {
      cancelled = true;
    };
  }, [token.surface]);

  // The panel is a fixed overlay on the right. Flagging it on the document lets
  // the page underneath reserve that strip instead of being covered by it.
  useEffect(() => {
    document.documentElement.classList.add('panel-open');
    return () => document.documentElement.classList.remove('panel-open');
  }, []);

  const enroll = async () => {
    if (!token.wordId) return;
    setEnrolling(true);
    try {
      await api.enrollWord(token.wordId);
      setEnrolled(true);
      onEnrolled?.();
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="jp-line" style={{ fontSize: '1.9rem' }}>
            <Furigana segments={token.furigana} />
          </div>
          <div className="romaji" style={{ fontSize: '0.95rem' }}>
            {token.romaji}
          </div>
        </div>
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="row" style={{ marginBottom: '0.8rem' }}>
        {token.entry?.jlpt && <span className="tag jlpt">N{token.entry.jlpt}</span>}
        {token.entry?.common && <span className="tag">common</span>}
        {token.pos && <span className="tag">{token.pos}</span>}
        {token.baseForm !== token.surface && (
          <span className="tag">
            dict. form <RubyText text={token.baseForm} />
          </span>
        )}
      </div>

      {token.conjugation && (
        <p className="muted" style={{ fontSize: '0.88rem', marginTop: 0 }}>
          Built from{' '}
          <b className="mono">
            <RubyText text={token.parts.join(' + ')} />
          </b>
        </p>
      )}

      {token.functionGloss && (
        <div className="notice" style={{ marginBottom: '0.8rem' }}>
          <RubyText text={token.functionGloss} />
        </div>
      )}

      {token.entry ? (
        <>
          <h2 style={{ marginTop: '0.4rem' }}>Meaning</h2>
          {token.entry.senses.map((sense, i) => (
            <div className="sense" key={i}>
              <div className="pos">{sense.pos.join(', ')}</div>
              <div>
                <RubyText text={sense.glosses.join('; ')} />
              </div>
              {sense.misc.length > 0 && <div className="faint mono">{sense.misc.join(', ')}</div>}
            </div>
          ))}
        </>
      ) : (
        !token.functionGloss && (
          <p className="muted">
            No dictionary entry — likely a name, a coined word, or a parsing slip.
          </p>
        )
      )}

      {token.grammar.length > 0 && (
        <>
          <h2>Grammar here</h2>
          {token.grammar.map((g) => (
            <div className="card" key={g.key} style={{ marginBottom: '0.5rem' }}>
              <div className="jp-line" style={{ fontSize: '1.05rem' }}>
                <RubyText text={g.pattern} />
              </div>
              <div className="muted" style={{ fontSize: '0.88rem' }}>
                <RubyText text={g.explanation} />
              </div>
            </div>
          ))}
        </>
      )}

      <h2>See it used · ask about it</h2>
      <WordExtras
        word={{
          term: token.surface,
          reading: token.reading,
          meaning:
            token.functionGloss ?? token.entry?.senses[0]?.glosses.slice(0, 3).join('; ') ?? '',
          lineText,
          songId,
        }}
      />

      {kanji.length > 0 && (
        <>
          <h2>Kanji inside</h2>
          {kanji.map((k) => (
            <div className="card" key={k.char} style={{ marginBottom: '0.5rem' }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="jp-line" style={{ fontSize: '2rem' }}>
                  {k.char}
                </span>
                <div style={{ flex: 1 }}>
                  <div>{k.meanings.slice(0, 4).join(', ')}</div>
                  {/* Same split as on the stage: the readings are the content, the
                      "on"/"kun" beside them only say which is which. */}
                  <div className="yomi" style={{ fontSize: '0.82rem' }}>
                    {k.on.length > 0 && (
                      <span>
                        <span className="lbl">on</span>
                        {k.on.slice(0, 4).join('・')}
                      </span>
                    )}
                    {k.kun.length > 0 && (
                      <span>
                        <span className="lbl">kun</span>
                        {k.kun.slice(0, 4).join('・')}
                      </span>
                    )}
                  </div>
                  {/* Meaning hook only — see the note on the stage's kanji column. */}
                  {k.mnemonic && (
                    <div className="mnemo">
                      <div>
                        <span className="lbl">means</span>
                        <RubyText text={k.mnemonic.meaning} />
                      </div>
                    </div>
                  )}
                  <div className="faint mono" style={{ fontSize: '0.75rem' }}>
                    {k.strokes ? `${k.strokes} strokes` : ''}
                    {k.grade ? ` · taught in grade ${k.grade}` : ''}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {token.wordId && !token.inDeck && (
        <button
          className="primary"
          style={{ width: '100%', marginTop: '1rem' }}
          onClick={enroll}
          disabled={enrolling || enrolled}
        >
          {enrolled ? '✓ Added to your deck' : enrolling ? 'Adding…' : 'Add this word to my deck'}
        </button>
      )}
      {token.inDeck && (
        <p className="faint" style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
          Already in your review deck.
        </p>
      )}
    </aside>
  );
}
