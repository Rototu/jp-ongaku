import { useState } from 'react';
import { typedToKana, type ReadingCheck } from '../../../../shared/kana';

/**
 * The typed-reading answer: an input that turns romaji into kana live, and —
 * once checked — the character-level diff against the real reading.
 *
 * The input and the diff are two halves of one interaction: type, press
 * Enter, see which characters you had right. The diff marks the shared
 * prefix and suffix as plain text and the differing middle in coral, so a
 * miss reads as "these two characters" rather than a red word.
 */
export function TypedAnswer({
  autoFocus,
  disabled,
  onSubmit,
}: {
  autoFocus: boolean;
  disabled: boolean;
  onSubmit: (raw: string) => void;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    if (!value.trim() || disabled) return;
    onSubmit(value);
  };

  return (
    <form
      className="typed-row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        className="jp-line"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="type the reading — romaji ok"
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        disabled={disabled}
      />
      <div className="typed-preview mono">
        {typedToKana(value) || <span className="faint">your answer in kana</span>}
      </div>
      <button className="primary small" disabled={!value.trim() || disabled} onClick={submit}>
        Check <span className="kbd">⏎</span>
      </button>
    </form>
  );
}

/** The comparison after a check: what was typed against the real reading. */
export function ReadingDiff({
  check,
  expectedReading,
}: {
  check: ReadingCheck;
  expectedReading: string;
}) {
  const parts = (check: ReadingCheck, which: 'typed' | 'expected') =>
    check[which].map((p, i) => (
      <span key={i} className={p.wrong ? 'wrong' : ''}>
        {p.text}
      </span>
    ));

  return (
    <div className="diff-strip">
      <div className="verdict">
        {check.correct ? (
          <span className="good">✓ correct reading</span>
        ) : (
          <span className="miss">✗ not quite — {expectedReading}</span>
        )}
      </div>
      {!check.correct && (
        <>
          <div className="diff">
            <span className="cap">you typed</span>
            <span className="jp-line">{parts(check, 'typed')}</span>
          </div>
          <div className="diff">
            <span className="cap">reading</span>
            <span className="jp-line">{parts(check, 'expected')}</span>
          </div>
        </>
      )}
    </div>
  );
}
