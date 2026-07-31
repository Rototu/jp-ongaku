import { useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../lib/shell';

/**
 * ⌘K — one place for everything that isn't Play or Study.
 *
 * The song page used to carry a dozen buttons; they all still exist, they are
 * just typed for instead of hunted for. Keyboard only by design: arrow keys move,
 * enter runs, escape leaves.
 */
export function CommandPalette({
  commands,
  open,
  onClose,
}: {
  commands: Command[];
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // The input mounts with the overlay, so focusing waits a frame.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 40);
    return commands
      .filter((cmd) => `${cmd.label} ${cmd.where ?? ''}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [commands, query]);

  useEffect(() => {
    if (cursor >= matches.length) setCursor(0);
  }, [matches.length, cursor]);

  if (!open) return null;

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div className="cmdk-back" onClick={onClose} role="presentation">
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search songs, words, anything…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(matches.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(matches[cursor]);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        {matches.length === 0 ? (
          <div className="none">Nothing matches “{query}”.</div>
        ) : (
          <ul role="listbox">
            {matches.map((cmd, i) => (
              <li
                key={cmd.id}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => run(cmd)}
              >
                <span>{cmd.label}</span>
                {cmd.hint && <span className="kbd">{cmd.hint}</span>}
                {cmd.where && <span className="where">{cmd.where}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
