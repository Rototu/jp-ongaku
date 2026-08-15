import { useState } from 'react';
import { clock } from '../../components/bits';

/**
 * Lets the user type the real reading of a title.
 *
 * Accepts kana or romaji — the server converts either into kana and realigns the
 * furigana against the kanji.
 */
export function ReadingEditor({
  title,
  current,
  onSave,
  onCancel,
}: {
  title: string;
  current: string;
  onSave: (reading: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that reading');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="cap" style={{ marginBottom: 6 }}>
        how is 「{title}」 actually pronounced? kana or romaji
      </div>
      <div className="row">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') onCancel();
          }}
          autoFocus
          style={{ flex: 1, minWidth: 160 }}
          placeholder="ぐれんげ / gurenge"
        />
        <button className="primary small" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
        Leave it empty and save to go back to the automatic guess.
      </div>
    </div>
  );
}

/**
 * Notes about the song, handed to the model whenever it explains a line, a word
 * or an example. Most songs need nothing here — but where the meaning depends on
 * who is singing, no amount of grammar recovers it.
 *
 * It is also where pronunciation instructions go: the dictionary lists what a
 * kanji *can* be read as, and an instruction here outranks it, so a name or a
 * singer's own reading can be fixed for the whole song in one place.
 */
export function ContextEditor({
  value,
  onSave,
  onClose,
}: {
  value: string | null;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div className="card">
      <div className="cap">what the model should know about this song · how to read it</div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={5}
        style={{ marginTop: 8 }}
        placeholder={
          'e.g. Sung by the younger sister after her brother leaves — 「あの人」 throughout is him, not a lover.\n' +
          'Pronunciation instructions belong here too: 「今日」 is こんにち in this song, 「宵星」 is read よいぼし.'
        }
      />
      <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
        Readings are chosen by the AI from every reading the dictionary allows — anything you say here
        outranks both.
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="primary small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(text);
              setSaved(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save context'}
        </button>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
        <span className="faint" style={{ fontSize: 13 }}>
          {saved
            ? 'Saved. Re-explain the song from ⌘K to redo the translations with it.'
            : 'Applies to new explanations — re-explain the song to redo existing lines.'}
        </span>
      </div>
    </div>
  );
}

/**
 * Moves every line of the song by one offset.
 *
 * Crowdsourced lyrics are often timed against a different cut — an opening-theme
 * edit with no intro, a stream master with a longer one — and then the spacing is
 * right while the start is wrong, so every line arrives the same amount early or
 * late. Tapping the whole song again to correct a constant is the wrong tool; this
 * takes the constant. The fastest way to find it is to play up to the moment the
 * first line is sung and let the field read it off the clock.
 */
export function OffsetEditor({
  firstLineMs,
  positionMs,
  onShift,
  onClose,
}: {
  /** Where the first timed line currently sits, the thing being corrected. */
  firstLineMs: number | null;
  /** Playhead, so "it should start here" can be taken from the video itself. */
  positionMs: number;
  onShift: (ms: number) => Promise<void>;
  onClose: () => void;
}) {
  const [seconds, setSeconds] = useState('');
  const [busy, setBusy] = useState(false);

  const typed = Number(seconds);
  const ready = seconds.trim() !== '' && Number.isFinite(typed) && typed !== 0;

  const apply = async (ms: number) => {
    setBusy(true);
    try {
      await onShift(ms);
      setSeconds('');
    } finally {
      setBusy(false);
    }
  };

  // What the offset would be if the first line belongs where the video is now.
  const fromPlayhead =
    firstLineMs === null ? null : Math.round((positionMs - firstLineMs) / 100) / 10;

  return (
    <div className="card stack">
      <div className="cap">
        move every line{firstLineMs === null ? '' : ` · first line at ${clock(firstLineMs)}`}
      </div>
      <div className="row">
        {[-1, -0.5, 0.5, 1].map((step) => (
          <button
            key={step}
            className="ghost small"
            disabled={busy}
            onClick={() => apply(step * 1000)}
          >
            {step > 0 ? `+${step}s later` : `${step}s earlier`}
          </button>
        ))}
        <span className="spacer" />
        <input
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) void apply(typed * 1000);
            if (e.key === 'Escape') onClose();
          }}
          placeholder="e.g. 19.5"
          inputMode="decimal"
          style={{ width: 110 }}
          autoFocus
        />
        <button className="primary small" disabled={busy || !ready} onClick={() => apply(typed * 1000)}>
          {busy ? 'Moving…' : 'Move by seconds'}
        </button>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      {fromPlayhead !== null && Math.abs(fromPlayhead) >= 0.5 && (
        <div className="row">
          <button className="dark small" disabled={busy} onClick={() => apply(fromPlayhead * 1000)}>
            First line starts here ({fromPlayhead > 0 ? '+' : ''}
            {fromPlayhead}s)
          </button>
          <span className="faint" style={{ fontSize: 12.5 }}>
            Pause the video the moment line one is sung, then press this.
          </span>
        </div>
      )}
      <span className="faint" style={{ fontSize: 12.5 }}>
        Positive moves the lyrics later, for lyrics timed to a cut with a shorter intro.
        Listening clips move with them.
      </span>
    </div>
  );
}
