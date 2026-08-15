import { useState } from 'react';
import {
  api,
  type ImportResult,
  type SearchHit,
  type YoutubeMeta,
} from '../../lib/api';
import { Art } from '../../components/bits';
import { TitleText } from '../../components/Furigana';

/** True for text the import field should treat as a video rather than a title. */
export function isYoutubeLink(text: string): boolean {
  return /(youtube\.com|youtu\.be)\//i.test(text.trim());
}

/**
 * The one-field import.
 *
 * A title is enough: LRCLIB is searched for it, Japanese results with timings
 * rank first, and everything else — video, notes, hand-pasted lyrics — is a chip
 * away and editable later.
 *
 * A YouTube link is enough too, and is the better path: the video says what the
 * song is *and* how long it runs, so the candidates can be ranked against the
 * recording the user is going to sing along to — the full song above the TV-size
 * edit — and the video attaches itself to whatever they pick.
 */
export function ImportCard({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);

  const [showVideo, setShowVideo] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [youtube, setYoutube] = useState('');
  const [context, setContext] = useState('');
  const [video, setVideo] = useState<YoutubeMeta | null>(null);

  const pasted = isYoutubeLink(query);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setHits(null);
    try {
      if (pasted) {
        const res = await api.resolveYoutube(query.trim());
        setVideo(res.video);
        // The link is the video now: no reason to make them paste it twice.
        setYoutube(res.video.videoId);
        setHits(res.hits);
        if (res.error) setError(res.error);
        else if (res.hits.length === 0) {
          setError(
            `Read the video as “${res.video.title}” by ${res.video.artist || 'unknown'}, but found no lyrics for it. ` +
              'Try typing the title instead, or paste the lyrics.',
          );
          setShowPaste(true);
        }
      } else {
        setVideo(null);
        const res = await api.search(query.trim());
        setHits(res.hits);
        if (res.hits.length === 0) {
          setError('Nothing found. Try the Japanese title, or paste the lyrics instead.');
          setShowPaste(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const importHit = async (hit: SearchHit) => {
    setImportingId(hit.id);
    setError(null);
    try {
      const res = await api.importFromLrclib(
        hit.id,
        youtube.trim() || undefined,
        context.trim() || undefined,
      );
      onImported(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="import-card">
      <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ fontSize: 28 }}>What are you listening to?</h2>
        <span className="faint" style={{ fontSize: 13 }}>
          A title or a YouTube link. One field is all we need.
        </span>
      </div>

      <form className="one-field" onSubmit={search}>
        <div className="field">
          <span style={{ fontSize: 18, color: 'var(--faint)' }}>{pasted ? '▶' : '⌕'}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="紅蓮華 / Gurenge — or paste a youtube link"
            autoFocus
          />
          {hits && (
            <span className="cap" style={{ whiteSpace: 'nowrap' }}>
              {hits.length} MATCHES
            </span>
          )}
        </div>
        <button className="primary find" disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : pasted ? 'Read it' : 'Find it'}
        </button>
      </form>

      {video && (
        <div className="from-video">
          <img
            className="shot"
            src={video.thumbnailUrl ?? `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`}
            alt=""
          />
          <div className="who">
            <div className="cap">from the video</div>
            <div style={{ fontWeight: 700 }}>
              <span className="jps">{video.title}</span>
              {video.artist ? <span className="faint"> · {video.artist}</span> : null}
            </div>
            <div className="mono faint" style={{ fontSize: 11.5 }}>
              {video.durationSec ? `${formatDuration(video.durationSec)} · ` : ''}
              {video.channel}
              {video.guessedBy === 'ai' ? ' · title split by the AI layer' : ''}
            </div>
          </div>
          {/* Says out loud what the ranking below is doing, so a surprising order
              reads as deliberate rather than broken. */}
          <span className="cap" style={{ textAlign: 'right', maxWidth: 190 }}>
            {video.durationSec
              ? 'lyrics closest to this length rank first'
              : 'the video will be attached'}
          </span>
        </div>
      )}

      <div className="chips">
        {/* Hidden once a link has been read: the video is already attached, and
            offering to add one reads as if it were not. */}
        {!video && (
          <button
            className={`chip${showVideo ? ' on' : ''}`}
            onClick={() => setShowVideo((v) => !v)}
          >
            ＋ Add a video link
          </button>
        )}
        <button
          className={`chip${showContext ? ' on' : ''}`}
          onClick={() => setShowContext((v) => !v)}
        >
          ＋ Tell the AI about the song
        </button>
        <button
          className={`chip${showPaste ? ' on' : ''}`}
          onClick={() => setShowPaste((v) => !v)}
        >
          ＋ Paste lyrics instead
        </button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          — all optional, all editable later
        </span>
      </div>

      {showVideo && !video && (
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            youtube link — enables sing-along, stage mode and listening cards
          </div>
          <input
            value={youtube}
            onChange={(e) => setYoutube(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
          />
        </label>
      )}

      {showContext && (
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            what the model should know · how to read it
          </div>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={4}
            placeholder={
              'e.g. Ending theme of the second season — the singer is the character who dies in episode 9.\n' +
              'Pronunciation instructions count too: 「上」 is うえ throughout, the title is read as a name.'
            }
          />
        </label>
      )}

      {error && <div className="error">{error}</div>}

      {hits && hits.length > 0 && (
        <>
          {/* The video and the notes belong to the import, not to a row. The old
              layout put a VIDEO ATTACHED tag on the first result and styled its
              button as the live one, which read as "this is the only one you can
              add anything to". Said once, above the list, it is true of all. */}
          <div className="hit-header">
            <span className="cap">pick the one that matches your recording</span>
            <span className="spacer" />
            {(youtube.trim() || context.trim()) && (
              <span className="faint" style={{ fontSize: 12.5 }}>
                {[youtube.trim() && 'your video', context.trim() && 'your notes']
                  .filter(Boolean)
                  .join(' and ')}{' '}
                will be attached to whichever you pick
              </span>
            )}
          </div>
          <div className="hit-list">
          {hits.map((hit, i) => (
            <div
              className={`hit${i === 0 && hit.japanese ? ' first' : ''}${hit.japanese ? '' : ' dim'}`}
              key={hit.id}
            >
              <Art
                quiet={!hit.japanese}
                size={52}
                youtubeId={video?.videoId}
                seed={hit.trackName}
              />
              <div className="who">
                <div className="title">
                  <TitleText
                    text={hit.trackName}
                    furigana={hit.titleFurigana}
                    romaji={null}
                  />
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {hit.titleRomaji ? `${hit.titleRomaji} · ` : ''}
                  {hit.artistName}
                  {/* The lyrics' own span is the honest length: LRCLIB's duration
                      field is crowdsourced and sometimes describes another cut. */}
                  {hit.lyricSpanSec
                    ? ` · ${formatDuration(hit.lyricSpanSec)} of lyrics`
                    : hit.duration
                      ? ` · ${formatDuration(hit.duration)}`
                      : ''}
                  {` · ${hit.lineCount} lines`}
                  {hit.duplicates > 0 ? ` · ${hit.duplicates + 1} entries, same timings` : ''}
                </div>
                {/* Where line one lands. When the same words appear twice with
                    different timings — a single and an edit with no intro — this is
                    the number that says which one your video is. */}
                {hit.lyricStartSec !== null && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                    first line at {formatDuration(hit.lyricStartSec)}
                  </div>
                )}
              </div>
              {hit.japanese ? (
                <span className="tag new">日本語</span>
              ) : (
                <span className="tag">NOT JAPANESE</span>
              )}
              {hit.hasSynced && <span className="tag ink">TIMED</span>}
              {hit.durationMismatch && hit.duration && (
                <span
                  className="tag loan"
                  title={`This entry is filed as ${formatDuration(hit.duration)}, but its timings run to ${formatDuration(hit.lyricSpanSec ?? 0)}. The full lyrics are imported and the length is corrected.`}
                >
                  LENGTH SUSPECT
                </span>
              )}
              {i === 0 && hit.japanese && (
                <span
                  className="tag outline"
                  title="Ranked first: Japanese script with timings. Any result below imports exactly the same way."
                >
                  BEST MATCH
                </span>
              )}
              {/* Every row gets the same button. Styling one of them as the
                  primary action made the others look inert. */}
              <button
                className="dark"
                disabled={importingId !== null}
                onClick={() => importHit(hit)}
              >
                {importingId === hit.id ? 'Building lesson…' : 'Make lesson ▸'}
              </button>
            </div>
          ))}
          </div>
        </>
      )}

      {showPaste && (
        <PastePane
          youtube={youtube}
          context={context}
          onImported={onImported}
        />
      )}
    </div>
  );
}

/** The escape hatch: LRCLIB has never heard of it, so type it in yourself. */
function PastePane({
  youtube,
  context,
  onImported,
}: {
  youtube: string;
  context: string;
  onImported: (r: ImportResult) => void;
}) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = title.trim() && artist.trim() && lyrics.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.importPasted({
        title: title.trim(),
        artist: artist.trim(),
        lyrics,
        youtubeId: youtube.trim() || undefined,
        context: context.trim() || undefined,
      });
      setLyrics('');
      onImported(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card flat stack" onSubmit={submit}>
      <div className="cap">paste the lyrics yourself</div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            title
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            artist
          </div>
          <input value={artist} onChange={(e) => setArtist(e.target.value)} />
        </label>
      </div>
      <label>
        <div className="cap" style={{ marginBottom: 4 }}>
          one line per line · blank lines separate sections · LRC timestamps are kept
        </div>
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          spellCheck={false}
          rows={8}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={busy || !ready}>
          {busy ? 'Building lesson…' : 'Build lesson'}
        </button>
        <span className="faint" style={{ fontSize: 13 }}>
          Everything stays on this machine.
        </span>
      </div>
    </form>
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
