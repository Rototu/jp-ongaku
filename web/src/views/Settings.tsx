import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * Settings: which AI backend powers the explanation layer, plus a plain
 * statement of what the app stores and where.
 */
export function Settings() {
  const settings = useAsync(() => api.settings(), []);
  const health = useAsync(() => api.health(), []);
  const [provider, setProvider] = useState('');
  const [gatewayKey, setGatewayKey] = useState('');
  const [gatewayModel, setGatewayModel] = useState('');
  const [effort, setEffort] = useState('none');
  const [concurrency, setConcurrency] = useState('4');
  const [lyricReadings, setLyricReadings] = useState('ai');
  const [youtubeKey, setYoutubeKey] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.settings.llm_provider ?? '');
      setGatewayModel(settings.data.settings.gateway_model ?? '');
      setEffort(settings.data.settings.reasoning_effort ?? 'none');
      setConcurrency(settings.data.settings.llm_concurrency ?? '4');
      setLyricReadings(settings.data.settings.lyric_readings ?? 'ai');
    }
  }, [settings.data]);

  const save = async () => {
    const body: Record<string, string | null> = {
      llm_provider: provider || null,
      gateway_model: gatewayModel || null,
      reasoning_effort: effort || null,
      llm_concurrency: concurrency || null,
      lyric_readings: lyricReadings || null,
    };
    if (gatewayKey.trim()) body.gateway_api_key = gatewayKey.trim();
    if (youtubeKey.trim()) body.youtube_api_key = youtubeKey.trim();
    const res = await api.saveSettings(body);
    setGatewayKey('');
    setYoutubeKey('');
    setSaved(res.llm.detail);
    settings.reload();
    health.reload();
  };

  const keySet = settings.data?.settings.gateway_api_key_set === 'yes';
  const youtubeKeySet = settings.data?.settings.youtube_api_key_set === 'yes';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">The AI layer is optional. Everything else works without it.</p>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ marginTop: 0 }}>Explanation engine</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Segmentation and dictionary meanings are computed locally. An AI backend decides the
          readings — choosing among every reading the dictionary allows, and following any
          instruction you leave with the song — and adds natural translations, grammar notes for each
          line, and memory hooks for cards you keep failing. Results are cached, so each song costs
          one batch of calls, once.
        </p>

        {settings.data && (
          <div className={settings.data.llm.available ? 'notice' : 'error'}>
            <b>Current:</b> {settings.data.llm.detail}
          </div>
        )}

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            AI layer
          </div>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="gateway">On — Vercel AI Gateway</option>
            <option value="none">Off — dictionary only</option>
          </select>
        </label>

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            Gateway API key {keySet && <span className="tag new">one is stored</span>}
          </div>
          <input
            type="password"
            value={gatewayKey}
            onChange={(e) => setGatewayKey(e.target.value)}
            placeholder={keySet ? 'Stored — type to replace' : 'vck_…'}
            autoComplete="off"
          />
        </label>

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            Model
          </div>
          <input
            value={gatewayModel}
            onChange={(e) => setGatewayModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-5"
          />
          <div className="faint" style={{ fontSize: '0.76rem', marginTop: '0.3rem' }}>
            Any model id the gateway accepts. Segmentation and readings are the part that
            has to be right — a stronger model gets rejected fewer times and needs fewer
            retries, so it is often no slower in practice.
          </div>
        </label>

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            Reasoning effort
          </div>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="none">None — fastest (default)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High — slowest</option>
            <option value="default">Leave to the model</option>
          </select>
          <div className="faint" style={{ fontSize: '0.76rem', marginTop: '0.3rem' }}>
            Reasoning models spend most of a request thinking before they answer. On a
            measured batch, dropping this to <b>none</b> cut 43s to 12s and stopped the
            answer overflowing its token limit. Raise it only if segmentations start
            getting rejected.
          </div>
        </label>

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            Parallel requests
          </div>
          <select value={concurrency} onChange={(e) => setConcurrency(e.target.value)}>
            <option value="1">1 — one at a time</option>
            <option value="2">2</option>
            <option value="4">4 (default)</option>
            <option value="6">6</option>
            <option value="8">8 — fastest, most likely to hit rate limits</option>
          </select>
          <div className="faint" style={{ fontSize: '0.76rem', marginTop: '0.3rem' }}>
            Batches of lines are independent, so they are sent at once. A rate limit
            pauses every request in flight, not just the one that hit it.
          </div>
        </label>

        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            Furigana over the lyrics
          </div>
          <select value={lyricReadings} onChange={(e) => setLyricReadings(e.target.value)}>
            <option value="ai">Only readings the AI decided (default)</option>
            <option value="dictionary">Dictionary readings until the AI has run</option>
          </select>
          <div className="faint" style={{ fontSize: '0.76rem', marginTop: '0.3rem' }}>
            The offline parse commits to one reading per word and cannot know that a
            singer reads 埋葬る as うめる or that a name breaks every rule. On the
            default, a line carries no furigana or romaji until the model has read it —
            no reading beats a confident wrong one. Songs already explained are
            unaffected either way.
          </div>
        </label>

        <div className="row">
          <button className="primary" onClick={save}>
            Save
          </button>
          {saved && <span className="muted">{saved}</span>}
        </div>
      </div>

      <h2>Video lengths</h2>
      <div className="card stack">
        <p className="muted" style={{ marginTop: 0 }}>
          Importing by YouTube link works without any key — the title and channel still name the
          song. A <b>YouTube Data API</b> key adds the video's exact length, so lyric candidates
          rank by how close their timings are to your recording: the full song sorts above the
          TV-size edit. Free quota; one key, no other scopes needed.
        </p>
        <label>
          <div className="faint" style={{ fontSize: '0.78rem', marginBottom: '0.25rem' }}>
            YouTube Data API key {youtubeKeySet && <span className="tag new">one is stored</span>}
          </div>
          <input
            type="password"
            value={youtubeKey}
            onChange={(e) => setYoutubeKey(e.target.value)}
            placeholder={youtubeKeySet ? 'Stored — type to replace' : 'AIza…'}
            autoComplete="off"
          />
          <div className="faint" style={{ fontSize: '0.76rem', marginTop: '0.3rem' }}>
            From Google Cloud Console → APIs &amp; Services → Credentials, with the YouTube Data
            API v3 enabled. Without it, imports rank candidates without the length.
          </div>
        </label>
      </div>

      <h2>Local data</h2>
      <div className="card">
        {health.data && (
          <ul className="muted" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li>
              Dictionary: {health.data.dictionary.available ? (
                <>
                  {health.data.dictionary.entries.toLocaleString()} entries,{' '}
                  {health.data.dictionary.kanji.toLocaleString()} kanji —{' '}
                  <code className="mono">data/dict.db</code>
                </>
              ) : (
                <>
                  missing. Run <code className="mono">bun run dict</code>.
                </>
              )}
            </li>
            <li>
              Your songs, cards and history: <code className="mono">data/ongaku.db</code>. Copy that
              one file to back everything up.
            </li>
            <li>
              A word enters your review deck automatically at priority{' '}
              {health.data.enrollThreshold} or above; rarer poetic words stay browsable but out of
              the deck until you add them.
            </li>
            <li>Katakana deck: {health.data.katakanaDeck} cards.</li>
          </ul>
        )}
      </div>

      <h2>Keyboard</h2>
      <div className="card muted stack" style={{ gap: 6 }}>
        <div className="row">
          <span className="kbd">⌘K</span> everything — songs, reviews, re-explain, re-time, romaji
        </div>
        <div className="row">
          <span className="kbd">⇧S</span> take the stage, from any song
        </div>
        <div className="row">
          <span className="kbd">space</span> reveal answer · <span className="kbd">1</span> again{' '}
          <span className="kbd">2</span> hard <span className="kbd">3</span> good{' '}
          <span className="kbd">4</span> easy
        </div>
        <div className="row">
          <span className="kbd">H</span> hear the card in the song
        </div>
        <div className="row">
          <span className="kbd">L</span> loop the line · <span className="kbd">T</span> hide the
          translation · <span className="kbd">←</span> <span className="kbd">→</span> step lines (stage
          mode)
        </div>
        <div className="row">
          <span className="kbd">space</span> tap a line's timing while syncing
        </div>
      </div>
    </>
  );
}
