import { useEffect, useRef, useState } from 'react';
import { api, type WordRefInput } from '../lib/api';
import type { WordExample, WordQuestion } from '../../../shared/types';
import { Furigana } from './Furigana';
import { RubyText } from './RubyText';

/**
 * The on-demand half of a word explanation: generated usage examples, and a
 * place to ask anything else about the word.
 *
 * Both are paid for once. Whatever the model returns is stored server-side
 * against the word itself, so re-opening the same word — tomorrow, in another
 * song, offline — shows the same material without another request. That is why
 * the examples load silently on open (a cache read) but are only generated when
 * the user asks for them.
 */
export function WordExtras({ word }: { word: WordRefInput }) {
  const { term, reading } = word;

  const [examples, setExamples] = useState<WordExample[] | null>(null);
  const [questions, setQuestions] = useState<WordQuestion[]>([]);
  const [loadingCache, setLoadingCache] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const askRef = useRef<HTMLTextAreaElement | null>(null);

  // Cached material for this word. Two plain reads — no model involved — so it
  // is safe to do on every open, including with no API key configured.
  useEffect(() => {
    let cancelled = false;
    setExamples(null);
    setQuestions([]);
    setError(null);
    setQuestion('');
    setLoadingCache(true);

    void Promise.all([
      api.wordExamples(term, reading ?? '').catch(() => ({ examples: null })),
      api.wordQuestions(term, reading ?? '').catch(() => ({ questions: [] })),
    ]).then(([ex, qs]) => {
      if (cancelled) return;
      setExamples(ex.examples);
      setQuestions(qs.questions);
      setLoadingCache(false);
    });

    return () => {
      cancelled = true;
    };
  }, [term, reading]);

  const generate = async (force = false) => {
    setGenerating(true);
    setError(null);
    try {
      const res = await api.generateExamples({ ...word, force });
      setExamples(res.examples);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate examples');
    } finally {
      setGenerating(false);
    }
  };

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setError(null);
    try {
      const res = await api.askWord({ ...word, question: q });
      // Replace rather than append when the same question was asked before, so
      // a repeat never shows twice.
      setQuestions((prev) => [
        ...prev.filter((h) => h.question !== q),
        { question: q, answer: res.answer, createdAt: new Date().toISOString() },
      ]);
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not answer that');
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="word-extras">
      <div className="row">
        {examples === null ? (
          <button className="small" onClick={() => generate()} disabled={generating || loadingCache}>
            {generating ? 'Writing examples…' : 'Generate usage examples'}
          </button>
        ) : (
          <button className="small ghost" onClick={() => generate(true)} disabled={generating}>
            {generating ? 'Writing examples…' : 'New examples'}
          </button>
        )}
        <button
          className="small ghost"
          onClick={() => {
            setAskOpen((v) => !v);
            // Focus after the field exists.
            requestAnimationFrame(() => askRef.current?.focus());
          }}
        >
          {askOpen ? 'Hide question box' : 'Ask something about this'}
        </button>
      </div>

      {error && (
        <div className="error" style={{ marginTop: '0.6rem' }}>
          {error}
        </div>
      )}

      {examples && examples.length > 0 && (
        <div className="examples">
          {examples.map((ex, i) => (
            <div className="example" key={i}>
              <div className="jp-line" style={{ fontSize: '1.15rem' }}>
                <Furigana segments={ex.furigana} />
              </div>
              <div className="romaji">{ex.romaji}</div>
              <div className="en">{ex.english}</div>
              {ex.note && (
                <div className="faint note">
                  <RubyText text={ex.note} />
                </div>
              )}
            </div>
          ))}
          <div className="faint" style={{ fontSize: '0.74rem' }}>
            Saved with the word — reopening it costs nothing.
          </div>
        </div>
      )}

      {askOpen && (
        <div className="ask-box">
          <textarea
            ref={askRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Anything about 「${term}」 — why this form, how it differs from a similar word, when to use it…`}
            rows={2}
            onKeyDown={(e) => {
              // Enter sends, shift+enter breaks the line: the questions are one
              // or two lines, and reaching for a button every time is friction.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="row">
            <button className="small primary" onClick={ask} disabled={asking || !question.trim()}>
              {asking ? 'Asking…' : 'Ask'}
            </button>
            <span className="faint" style={{ fontSize: '0.74rem' }}>
              <span className="kbd">enter</span> to send · answers are stored, so the same question
              is never asked twice
            </span>
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className="qa-list">
          {questions.map((qa) => (
            <div className="qa" key={qa.question}>
              <div className="q">
                <RubyText text={qa.question} />
              </div>
              <div className="a">
                <RubyText text={qa.answer} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
