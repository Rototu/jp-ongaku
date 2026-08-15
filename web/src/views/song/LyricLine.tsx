import { useMemo } from 'react';
import { Furigana } from '../../components/Furigana';
import { RubyText } from '../../components/RubyText';
import { WordPanel } from '../../components/WordPanel';
import { ChunkedLine, type ChunkMastery } from '../../components/ChunkedLine';
import { clock } from '../../components/bits';
import type { AnalyzedTokenView } from '../../lib/types';
import type { AiChunk, SongLine } from '../../../../shared/types';
import { roleColorIdx } from '../../../../shared/roles';

export function LyricLine({
  line,
  lineNumber,
  songId,
  active,
  past,
  nextToTap,
  trouble,
  lapses,
  showRomaji,
  offlineReadings,
  masteryOf,
  selectedChunk,
  onSelectChunk,
  selectedToken,
  onSelectToken,
  enrich,
  onEnrolled,
  onSeek,
  innerRef,
}: {
  line: SongLine;
  lineNumber: number;
  songId: number;
  active: boolean;
  past: boolean;
  nextToTap: boolean;
  trouble: boolean;
  lapses: number;
  showRomaji: boolean;
  /** Whether the offline parse's ruby may stand in until the model has read this line. */
  offlineReadings: boolean;
  masteryOf: (chunk: AiChunk) => ChunkMastery | null;
  selectedChunk: number | null;
  onSelectChunk: (idx: number | null) => void;
  selectedToken: number | null;
  onSelectToken: (idx: number | null) => void;
  enrich: (token: AnalyzedTokenView) => AnalyzedTokenView;
  onEnrolled: () => void;
  onSeek?: () => void;
  innerRef?: React.RefObject<HTMLDivElement>;
}) {
  const tokens = line.tokens as AnalyzedTokenView[];
  const chunks = line.analysis?.chunks ?? [];
  // AI segmentation wins where it exists: it handles set expressions and
  // context-dependent readings the local parse gets wrong. The local parse stays
  // as the offline fallback and keeps its dictionary links.
  const useChunks = chunks.length > 0;

  // The offline parse has no English role, only IPADIC tags; roleColorIdx reads
  // those too, so the fallback line is coloured by the same rules.
  const localColors = useMemo(
    () => tokens.map((t) => (t.filler ? -1 : roleColorIdx(`${t.pos} ${t.posDetail}`))),
    [tokens],
  );

  return (
    <div
      ref={innerRef}
      className={`lyric${active ? ' active' : ''}${past && !active ? ' past' : ''}${trouble ? ' trouble' : ''}`}
      style={nextToTap ? { boxShadow: 'inset 0 0 0 2px var(--lime)' } : undefined}
    >
      <div className="lyric-head">
        {onSeek ? (
          <button className="stamp" onClick={onSeek} title="Play from here">
            {active ? '▶ ' : ''}
            {line.timeMs === null ? '' : clock(line.timeMs)} · LINE {lineNumber}
          </button>
        ) : (
          <span className="cap">LINE {lineNumber}</span>
        )}
        {active && <span className="cap">click a word for its own explanation</span>}
        {trouble && <span className="tag leech">FAILED {lapses}×</span>}
      </div>

      {useChunks ? (
        <ChunkedLine
          chunks={chunks}
          selectedIdx={selectedChunk}
          onSelect={onSelectChunk}
          showRomaji={showRomaji}
          lineText={line.text}
          songId={songId}
          masteryOf={masteryOf}
        />
      ) : (
        <>
          <div className="jp-line">
            {tokens.map((token, i) =>
              token.filler ? (
                <span key={i} className="chunk plain">
                  {token.surface}
                </span>
              ) : (
                <span
                  key={i}
                  className={`chunk c${localColors[i]}${selectedToken === i ? ' selected' : ''}`}
                  onClick={() => onSelectToken(selectedToken === i ? null : i)}
                  title={
                    token.functionGloss ??
                    token.entry?.senses[0]?.glosses.slice(0, 2).join('; ') ??
                    token.surface
                  }
                >
                  {offlineReadings ? (
                    <Furigana segments={token.furigana} />
                  ) : (
                    // Plain, until the model has read the line. The segmentation
                    // and the colours are still useful; the guessed reading is not.
                    token.surface
                  )}
                  <span className="mastery">
                    <span style={{ width: token.inDeck ? '100%' : '0%' }} />
                  </span>
                </span>
              ),
            )}
          </div>
          {showRomaji && offlineReadings && (
            <div className="romaji">
              {tokens.map((token, i) =>
                token.filler ? (
                  <span key={i}>{token.surface}</span>
                ) : (
                  <span key={i} className={`c${localColors[i]}`}>
                    {token.romaji}{' '}
                  </span>
                ),
              )}
            </div>
          )}
          {!offlineReadings && (
            <div className="cap" style={{ marginTop: 6 }}>
              readings appear once the AI has read this line
            </div>
          )}
          {selectedToken !== null && tokens[selectedToken] && (
            <WordPanel
              key={`${line.id}-${selectedToken}`}
              token={enrich(tokens[selectedToken])}
              colorIdx={localColors[selectedToken]}
              lineText={line.text}
              songId={songId}
              onClose={() => onSelectToken(null)}
              onEnrolled={onEnrolled}
            />
          )}
        </>
      )}

      {line.analysis?.translation && (
        <div className="translation">
          <RubyText text={line.analysis.translation} />
        </div>
      )}
      {line.analysis?.literal && (
        <div className="literal">
          literally: <RubyText text={line.analysis.literal} />
        </div>
      )}
      {line.analysis?.notes?.map((note, i) => (
        <div className="note-chip" key={i}>
          <b>
            <RubyText text={note.pattern} />
          </b>
          <span>
            <RubyText text={note.explanation} />
          </span>
        </div>
      ))}
    </div>
  );
}
