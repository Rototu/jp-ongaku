import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Thin wrapper over the YouTube IFrame API, plus a progress bar.
 *
 * The API script is loaded lazily and only once. Playback position is polled at
 * 4Hz — enough to highlight the current lyric line without pinning a core, and
 * the only way to read position from an iframe player.
 *
 * Play state is reported upward from the API's own state events, not from
 * whichever button was pressed last. The video keeps YouTube's native controls,
 * so it can be started, paused or scrubbed inside the frame; deriving our own
 * state from our own buttons would then be a lie half the time.
 */

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: () => void;
            onStateChange?: (e: { data: number }) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
  return apiPromise;
}

export interface PlayerHandle {
  play(): void;
  pause(): void;
  /** Pauses if playing, plays if not. What a single toggle button needs. */
  toggle(): void;
  seekMs(ms: number): void;
  /** Plays a clip and pauses when it ends. Used by listening cards. */
  playClip(startMs: number, endMs: number): void;
  currentMs(): number;
}

/** mm:ss, or -:-- before the duration is known. */
function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-:--';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function YouTubePlayer({
  videoId,
  onReady,
  onTime,
  onPlayingChange,
  scrub = true,
}: {
  videoId: string;
  onReady?: (handle: PlayerHandle) => void;
  onTime?: (ms: number) => void;
  /** Fires whenever playback actually starts or stops, from any source. */
  onPlayingChange?: (playing: boolean) => void;
  /**
   * Whether to show the progress bar. Off on a listening card, where the point
   * is to hear one clip rather than to navigate the track.
   */
  scrub?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const clipEndRef = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Set while the user drags the bar, so the poll can't fight the drag. */
  const scrubbingRef = useRef(false);

  // Held in a ref so the effect that builds the player never has to depend on
  // the callback identity and tear the iframe down on every parent render.
  const playingChangeRef = useRef(onPlayingChange);
  playingChangeRef.current = onPlayingChange;
  const timeRef = useRef(onTime);
  timeRef.current = onTime;

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    loadApi()
      .then(() => {
        if (cancelled || !hostRef.current || !window.YT) return;

        // The API replaces the element it is handed with the iframe, so it gets a
        // throwaway child rather than the ref'd host: handing it the host would
        // detach the node React owns, and the next video would then build its
        // player inside an element no longer in the document.
        const mount = document.createElement('div');
        mount.style.width = '100%';
        mount.style.height = '100%';
        hostRef.current.appendChild(mount);

        const player = new window.YT.Player(mount, {
          videoId,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => {
              if (cancelled) return;
              setDurationMs(player.getDuration() * 1000);
              // Every method checks `cancelled` first. Callers hold the handle in
              // state, so one outlives its player whenever this component is
              // remounted — a review session unmounts it between listening cards
              // — and driving a destroyed player throws inside YouTube's own
              // code. Thrown from an effect, that took the whole app down.
              const handle: PlayerHandle = {
                play: () => {
                  if (!cancelled) player.playVideo();
                },
                pause: () => {
                  if (!cancelled) player.pauseVideo();
                },
                toggle: () => {
                  if (cancelled) return;
                  const playing = player.getPlayerState() === window.YT?.PlayerState.PLAYING;
                  if (playing) player.pauseVideo();
                  else player.playVideo();
                },
                seekMs: (ms) => {
                  if (!cancelled) player.seekTo(ms / 1000, true);
                },
                playClip: (startMs, endMs) => {
                  if (cancelled) return;
                  clipEndRef.current = endMs;
                  player.seekTo(startMs / 1000, true);
                  player.playVideo();
                },
                currentMs: () => (cancelled ? 0 : player.getCurrentTime() * 1000),
              };
              onReady?.(handle);
            },
            onStateChange: (e) => {
              if (cancelled) return;
              // Duration is 0 until the video is cued, so read it again here.
              const total = player.getDuration() * 1000;
              if (total > 0) setDurationMs(total);
              const isPlaying = e.data === window.YT?.PlayerState.PLAYING;
              setPlaying(isPlaying);
              playingChangeRef.current?.(isPlaying);
            },
          },
        });
        playerRef.current = player;

        poll = setInterval(() => {
          if (!playerRef.current) return;
          let ms: number;
          try {
            ms = playerRef.current.getCurrentTime() * 1000;
          } catch {
            return;
          }
          if (clipEndRef.current !== null && ms >= clipEndRef.current) {
            clipEndRef.current = null;
            playerRef.current.pauseVideo();
          }
          if (!scrubbingRef.current) setPositionMs(ms);
          timeRef.current?.(ms);
          // 4Hz is plenty to highlight the current line and to stop a clip at
          // its end; nothing here needs finer resolution.
        }, 250);
      })
      .catch(() => setFailed(true));

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      try {
        playerRef.current?.destroy();
      } catch {
        /* the iframe may already be gone */
      }
      playerRef.current = null;
      // Whatever destroy() left behind was appended here by hand, not by React,
      // so clearing it cannot fight the reconciler.
      hostRef.current?.replaceChildren();
    };
    // Recreate the player only when the video changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  /** Seeks to the point under the pointer, clamped to the track. */
  const seekToPointer = useCallback((clientX: number, track: HTMLElement) => {
    if (durationMs <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ms = ratio * durationMs;
    setPositionMs(ms);
    playerRef.current?.seekTo(ms / 1000, true);
    timeRef.current?.(ms);
  }, [durationMs]);

  const nudge = (deltaMs: number) => {
    const ms = Math.min(durationMs, Math.max(0, positionMs + deltaMs));
    setPositionMs(ms);
    playerRef.current?.seekTo(ms / 1000, true);
    timeRef.current?.(ms);
  };

  if (failed) {
    return (
      <div className="notice">
        Could not load the YouTube player (offline?). Everything else works — timings and listening
        cards just need the video.
      </div>
    );
  }

  const pct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <>
      <div className="yt-frame">
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        {/* Click the picture to play or pause. The layer stops short of the
            bottom strip so YouTube's own controls — its scrubber, volume,
            captions, fullscreen — stay clickable underneath. */}
        <button
          className="yt-tap"
          aria-label={playing ? 'Pause video' : 'Play video'}
          onClick={() => {
            const p = playerRef.current;
            if (!p) return;
            if (p.getPlayerState() === window.YT?.PlayerState.PLAYING) p.pauseVideo();
            else p.playVideo();
          }}
        />
      </div>
      {scrub && (
      <div className="yt-scrub">
        <span className="mono time">{clock(positionMs)}</span>
        {/* Dragging keeps working outside the element once the pointer is
            captured, which is what makes a thin bar usable at all. */}
        <div
          className="track"
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(positionMs / 1000)}
          aria-valuetext={clock(positionMs)}
          onPointerDown={(e) => {
            scrubbingRef.current = true;
            // Seek before capturing: setPointerCapture throws for a pointer id
            // the browser no longer tracks, and a plain click must still work.
            seekToPointer(e.clientX, e.currentTarget);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* drag-outside just won't track; the click already landed */
            }
          }}
          onPointerMove={(e) => {
            if (scrubbingRef.current) seekToPointer(e.clientX, e.currentTarget);
          }}
          onPointerUp={(e) => {
            scrubbingRef.current = false;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* never captured */
            }
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              nudge(5000);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              nudge(-5000);
            }
          }}
        >
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="knob" style={{ left: `${pct}%` }} />
        </div>
        <span className="mono time">{clock(durationMs)}</span>
      </div>
      )}
    </>
  );
}
