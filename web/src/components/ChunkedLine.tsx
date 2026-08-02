import type { AiChunk } from '../../../shared/types';
import { roleColorIdx } from '../../../shared/roles';
import { Furigana } from './Furigana';
import { RubyText } from './RubyText';
import { WordExtras } from './WordExtras';

/**
 * A lyric line rendered as coloured chunks.
 *
 * Two channels, deliberately separate. Colour is what a piece *does* — noun,
 * verb, particle — so the line can be taken apart before any of it is
 * understood, and the same hue means the same thing in every line. The bar
 * underneath is how well you know it, from the same SRS numbers the review
 * runner uses, so a line you can nearly sing looks different from one you have
 * never met.
 */

export interface ChunkMastery {
  /** 0..100, or -1 when the word is not in the deck at all. */
  value: number;
  trouble: boolean;
}

export function ChunkedLine({
  chunks,
  selectedIdx,
  onSelect,
  showRomaji,
  lineText,
  songId,
  masteryOf,
}: {
  chunks: AiChunk[];
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
  showRomaji: boolean;
  /** Passed down so examples and questions know where the word came from. */
  lineText: string;
  songId: number;
  masteryOf?: (chunk: AiChunk) => ChunkMastery | null;
}) {
  return (
    <>
      <div className="jp-line">
        {chunks.map((chunk, i) => {
          if (chunk.colorIdx < 0) {
            return (
              <span key={i} className="chunk plain">
                {chunk.text}
              </span>
            );
          }
          const mastery = masteryOf?.(chunk) ?? null;
          const classes = [
            'chunk',
            `c${roleColorIdx(chunk.role)}`,
            selectedIdx === i ? 'selected' : '',
            chunk.readingCheck === 'unverified' ? 'unverified' : '',
            mastery?.trouble ? 'trouble' : '',
            mastery && mastery.value >= 100 ? 'solid' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <span
              key={i}
              className={classes}
              onClick={() => onSelect(selectedIdx === i ? null : i)}
              title={chunk.meaning || chunk.text}
            >
              <Furigana segments={chunk.furigana} />
              <span className="mastery">
                <span style={{ width: `${Math.max(0, mastery?.value ?? 0)}%` }} />
              </span>
            </span>
          );
        })}
      </div>

      {showRomaji && (
        <div className="romaji">
          {chunks.map((chunk, i) =>
            chunk.colorIdx < 0 ? (
              <span key={i}>{chunk.text}</span>
            ) : (
              <span key={i} className={`c${roleColorIdx(chunk.role)}`}>
                {chunk.romaji}{' '}
              </span>
            ),
          )}
        </div>
      )}

      {selectedIdx !== null && chunks[selectedIdx] && (
        <ChunkDetail chunk={chunks[selectedIdx]} lineText={lineText} songId={songId} />
      )}
    </>
  );
}

function ChunkDetail({
  chunk,
  lineText,
  songId,
}: {
  chunk: AiChunk;
  lineText: string;
  songId: number;
}) {
  return (
    <div className={`chunk-detail c${roleColorIdx(chunk.role)}`}>
      <div className="head">
        <span className="jp-line" style={{ fontSize: 24, fontWeight: 700 }}>
          <Furigana segments={chunk.furigana} />
        </span>
        {chunk.romaji && <span className="romaji">{chunk.romaji}</span>}
        {chunk.role && (
          <span className="role">
            <em>
              <RubyText text={chunk.role} />
            </em>
          </span>
        )}
        {chunk.readingCheck === 'unverified' && (
          <span
            className="tag loan"
            title="This reading is not the dictionary reading for these characters. Common in songs, but worth a second look."
          >
            reading unverified
          </span>
        )}
      </div>
      {chunk.meaning && (
        <div className="meaning">
          <RubyText text={chunk.meaning} />
        </div>
      )}
      {chunk.explanation && (
        <div className="explanation">
          <RubyText text={chunk.explanation} />
        </div>
      )}
      <WordExtras
        word={{
          term: chunk.text,
          reading: chunk.reading,
          meaning: chunk.meaning,
          lineText,
          songId,
        }}
      />
    </div>
  );
}
