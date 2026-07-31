import type { FuriganaSegment } from '../../../shared/types';

/**
 * Renders Japanese text with furigana above every kanji run.
 *
 * Furigana is never optional in this app — the user reads little kanji, so
 * hiding readings would make the whole lesson unreadable. Segments come from
 * the server already aligned, so this is pure markup.
 */
export function Furigana({ segments, className }: { segments: FuriganaSegment[]; className?: string }) {
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.ruby ? (
          <ruby key={i}>
            {seg.text}
            <rt>{seg.ruby}</rt>
          </ruby>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/** Plain text with no ruby, for when only the surface matters. */
export function surfaceOf(segments: FuriganaSegment[]): string {
  return segments.map((s) => s.text).join('');
}

/**
 * A song or artist name: ruby above, romaji below, falling back to plain text
 * for names written in latin script (LiSA, YOASOBI).
 */
export function TitleText({
  text,
  furigana,
  romaji,
  className,
  romajiClassName,
}: {
  text: string;
  furigana?: FuriganaSegment[] | null;
  romaji?: string | null;
  className?: string;
  romajiClassName?: string;
}) {
  return (
    <>
      <span className={className}>
        {furigana && furigana.length > 0 ? <Furigana segments={furigana} /> : text}
      </span>
      {romaji && <div className={romajiClassName ?? 'romaji'}>{romaji}</div>}
    </>
  );
}
