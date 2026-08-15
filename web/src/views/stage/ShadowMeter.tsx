import { useEffect, useRef, useState } from 'react';

/**
 * The microphone level, and how many lines you sang over.
 *
 * Off until asked for. When on, audio never leaves the AnalyserNode: no
 * recording is kept, nothing is uploaded, and the only thing derived from it is
 * "was there sound while this line was on screen".
 */
export function ShadowMeter({ activeLineIdx, playing }: { activeLineIdx: number; playing: boolean }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [sung, setSung] = useState<Set<number>>(new Set());
  const [heard, setHeard] = useState(0);
  const lineRef = useRef(activeLineIdx);
  lineRef.current = activeLineIdx;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = granted;
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(granted);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(data);
          const band = Math.floor(data.length / 6);
          const next: number[] = [];
          let peak = 0;
          for (let b = 0; b < 6; b++) {
            let sum = 0;
            for (let i = b * band; i < (b + 1) * band; i++) sum += data[i];
            const value = sum / band / 255;
            peak = Math.max(peak, value);
            next.push(value);
          }
          setLevels(next);
          setHeard(peak);
          // A line counts as sung once there was real signal while it was up.
          if (peak > 0.16 && playingRef.current) {
            const at = lineRef.current;
            setSung((prev) => (prev.has(at) ? prev : new Set(prev).add(at)));
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (!cancelled) {
          setError('No microphone — shadowing needs one.');
          setOn(false);
        }
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [on]);

  if (!on) {
    return (
      <button className="stage-btn" onClick={() => setOn(true)} title={error ?? undefined}>
        🎤 {error ? 'Shadowing unavailable' : 'Shadow'}
      </button>
    );
  }

  return (
    <div className="shadow-meter" style={{ margin: 0 }}>
      <div className="inner">
        <span className="cap" style={{ color: 'var(--lime)' }}>
          Shadowing
        </span>
        <div className="eq">
          {levels.map((level, i) => (
            <span
              key={i}
              style={{
                height: `${Math.max(12, level * 100)}%`,
                background: level > 0.4 ? 'var(--lime)' : 'var(--leaf)',
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 13, color: 'var(--sage)' }}>
          {sung.size > 0
            ? `you sang ${sung.size} line${sung.size === 1 ? '' : 's'}${heard > 0.5 ? ' · loud' : ''}`
            : 'sing — nothing is recorded'}
        </span>
        <button className="stage-btn" onClick={() => setOn(false)}>
          Stop
        </button>
      </div>
    </div>
  );
}
