import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './lib/api';
import { useAsync } from './lib/useAsync';
import { ShellProvider, type Command } from './lib/shell';
import { CommandPalette } from './components/CommandPalette';
import { Library } from './views/Library';
import { SongView } from './views/SongView';
import { Review, type ReviewOptions } from './views/Review';
import { Dashboard } from './views/Dashboard';
import { Settings } from './views/Settings';
import { Today } from './views/Today';

type View =
  | { name: 'today' }
  | { name: 'library' }
  | { name: 'song'; songId: number }
  | { name: 'review'; options: ReviewOptions }
  | { name: 'progress' }
  | { name: 'settings' };

/** Serialises a view into the URL hash so reloads and back/forward work. */
function toHash(view: View): string {
  switch (view.name) {
    case 'song':
      return `#/song/${view.songId}`;
    case 'review':
      return `#/review${view.options.songId ? `/song/${view.options.songId}` : ''}${
        view.options.leeches ? '/leeches' : ''
      }${view.options.kinds?.length ? `/kinds/${view.options.kinds.join(',')}` : ''}`;
    case 'library':
      return '#/songs';
    case 'progress':
      return '#/progress';
    case 'settings':
      return '#/settings';
    default:
      return '#/';
  }
}

function fromHash(hash: string): View {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'song' && parts[1]) return { name: 'song', songId: Number(parts[1]) };
  if (parts[0] === 'review') {
    const options: ReviewOptions = {};
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === 'song' && parts[i + 1]) options.songId = Number(parts[++i]);
      else if (parts[i] === 'leeches') options.leeches = true;
      else if (parts[i] === 'kinds' && parts[i + 1]) {
        options.kinds = parts[++i].split(',') as ReviewOptions['kinds'];
      }
    }
    return { name: 'review', options };
  }
  if (parts[0] === 'songs' || parts[0] === 'library') return { name: 'library' };
  if (parts[0] === 'progress') return { name: 'progress' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'today' };
}

export function App() {
  const [view, setView] = useState<View>(() => fromHash(window.location.hash));
  const stats = useAsync(() => api.stats(), []);
  const health = useAsync(() => api.health(), []);
  const songs = useAsync(() => api.songs(), []);

  /**
   * The sidebar block belongs to whatever is on screen, so the shell leaves it an
   * empty element and the view portals into it. Held as state only so the first
   * render after the ref lands passes it down.
   */
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  const [viewCommands, setViewCommands] = useState<Command[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** One-shot message from an import, shown on the song page it produced. */
  const [flash, setFlash] = useState<string | null>(null);

  const go = useCallback((next: View) => {
    window.location.hash = toHash(next);
    setView(next);
  }, []);

  useEffect(() => {
    const onHash = () => setView(fromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ⌘K / Ctrl-K anywhere. Bound on window so it works with the lyrics focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const due = stats.data?.dueNow ?? 0;
  const leeches = stats.data?.leeches ?? 0;
  const library = songs.data?.songs ?? [];

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'go-today', label: 'Today', where: 'Go', run: () => go({ name: 'today' }) },
      { id: 'go-songs', label: 'Songs', where: 'Go', run: () => go({ name: 'library' }) },
      { id: 'go-progress', label: 'Progress', where: 'Go', run: () => go({ name: 'progress' }) },
      { id: 'go-settings', label: 'Settings', where: 'Go', run: () => go({ name: 'settings' }) },
      {
        id: 'review-all',
        label: due > 0 ? `Review ${due} due cards` : 'Review (nothing due — go ahead anyway)',
        where: 'Review',
        run: () => go({ name: 'review', options: {} }),
      },
      {
        id: 'review-leeches',
        label: `Drill ${leeches} trouble card${leeches === 1 ? '' : 's'}`,
        where: 'Review',
        run: () => go({ name: 'review', options: { leeches: true, title: 'Trouble drill' } }),
      },
      {
        id: 'review-kana',
        label: 'Katakana drill',
        where: 'Review',
        run: () => go({ name: 'review', options: { kinds: ['kana'], title: 'Katakana drill' } }),
      },
      {
        id: 'review-listening',
        label: 'Listening only',
        where: 'Review',
        run: () =>
          go({ name: 'review', options: { kinds: ['listening'], title: 'Listening' } }),
      },
    ];

    const songCommands: Command[] = library.map((song) => ({
      id: `song-${song.id}`,
      label: `${song.title} — ${song.artist}`,
      where: 'Open song',
      run: () => go({ name: 'song', songId: song.id }),
    }));

    return [...viewCommands, ...nav, ...songCommands];
  }, [viewCommands, library, due, leeches, go]);

  const llmOn = health.data?.llm.available ?? false;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="note">♪</span>
          <div>
            <div className="name">jp-ongaku</div>
            <small>japanese through song</small>
          </div>
        </div>

        <nav>
          <NavItem
            label="Today"
            active={view.name === 'today'}
            onClick={() => go({ name: 'today' })}
          />
          <NavItem
            label="Songs"
            active={view.name === 'library' || view.name === 'song'}
            badge={library.length > 0 ? <span className="badge quiet">{library.length}</span> : null}
            onClick={() => go({ name: 'library' })}
          />
          <NavItem
            label="Review"
            active={view.name === 'review'}
            badge={due > 0 ? <span className="badge">{due}</span> : null}
            onClick={() => go({ name: 'review', options: {} })}
          />
          <NavItem
            label="Progress"
            active={view.name === 'progress'}
            badge={leeches > 0 ? <span className="badge bad">{leeches}</span> : null}
            onClick={() => go({ name: 'progress' })}
          />
          <NavItem
            label="Settings"
            active={view.name === 'settings'}
            onClick={() => go({ name: 'settings' })}
          />
        </nav>

        <div className="rail-slot" ref={setRailSlot} />

        <div className="sidebar-foot">
          <div className={`status${llmOn ? '' : ' off'}`}>
            <span className="dot" />
            {llmOn ? 'AI layer on' : 'AI layer off — dictionary only'}
          </div>
          <div className="status">
            <span className="dot" />
            All local · nothing uploaded
          </div>
          <button className="hint" onClick={() => setPaletteOpen(true)}>
            ⌘K FOR ANYTHING
          </button>
        </div>
      </aside>

      <main className="main">
        <ShellProvider railSlot={railSlot} onCommands={setViewCommands}>
          {view.name === 'today' && (
            <Today
              onReview={(options) => go({ name: 'review', options })}
              onOpenSong={(songId) => go({ name: 'song', songId })}
              onNewSong={() => go({ name: 'library' })}
              onSearch={() => setPaletteOpen(true)}
            />
          )}

          {view.name === 'library' && (
            <Library
              onNotice={setFlash}
              onOpen={(songId) => {
                stats.reload();
                songs.reload();
                go({ name: 'song', songId });
              }}
              onChanged={() => {
                songs.reload();
                stats.reload();
              }}
            />
          )}

          {view.name === 'song' && (
            <SongView
              songId={view.songId}
              notice={flash}
              onNoticeSeen={() => setFlash(null)}
              onBack={() => go({ name: 'library' })}
              onStudy={(songId) => go({ name: 'review', options: { songId } })}
            />
          )}

          {view.name === 'review' && (
            <Review
              options={view.options}
              onDone={() => {
                stats.reload();
                go({ name: 'today' });
              }}
              onOpenSong={(songId) => go({ name: 'song', songId })}
              onChanged={stats.reload}
            />
          )}

          {view.name === 'progress' && (
            <Dashboard
              onReview={(options) => go({ name: 'review', options })}
              onOpenSong={(songId) => go({ name: 'song', songId })}
            />
          )}

          {view.name === 'settings' && <Settings />}
        </ShellProvider>
      </main>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

export function NavItem({
  label,
  active,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  badge?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <span className="dot" />
      {label}
      <span className="spacer" />
      {badge}
    </button>
  );
}
