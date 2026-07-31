import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The plumbing between a view and the app shell around it.
 *
 * Two things travel outwards. The sidebar's middle block belongs to whatever is
 * on screen — the streak on Today, sort chips on Songs, the section spine in a
 * song — so a view renders into a slot the shell leaves for it. That is a portal
 * rather than a piece of shared state on purpose: pushing a node up into the
 * shell's state means every render of the view sets that state, and the shell
 * re-rendering the view then sets it again.
 *
 * Commands do have to be state, since the palette lives beside the view rather
 * than inside it — so they are compared by signature before being pushed up, and
 * only a genuinely different list causes a shell render.
 */

export interface Command {
  /** Stable id, so re-registering the same command does not duplicate it. */
  id: string;
  label: string;
  /** Where the command comes from, shown right-aligned in the palette. */
  where?: string;
  hint?: string;
  run: () => void;
}

interface ShellApi {
  railSlot: HTMLElement | null;
  setCommands: (commands: Command[]) => void;
}

const ShellContext = createContext<ShellApi | null>(null);

export function ShellProvider({
  children,
  railSlot,
  onCommands,
}: {
  children: ReactNode;
  railSlot: HTMLElement | null;
  onCommands: (commands: Command[]) => void;
}) {
  const api = useMemo<ShellApi>(() => ({ railSlot, setCommands: onCommands }), [
    railSlot,
    onCommands,
  ]);
  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}

/**
 * Renders `node` into the sidebar's slot. The result must be included in the
 * view's own output — it is a portal, so it appears in the sidebar, not inline.
 */
export function useRail(node: ReactNode): ReactNode {
  const shell = useContext(ShellContext);
  if (!shell?.railSlot) return null;
  return createPortal(node, shell.railSlot);
}

/**
 * Publishes this view's commands to ⌘K.
 *
 * The list is rebuilt on every render — the closures inside it have to see
 * current state — so it is compared by id and label before being pushed upwards,
 * and the shell reads the latest closures through a ref when a command runs.
 */
export function useCommands(commands: Command[]) {
  const shell = useContext(ShellContext);
  const signature = commands.map((c) => `${c.id}:${c.label}`).join('|');
  const latest = useRef(commands);
  latest.current = commands;

  useEffect(() => {
    const stable = latest.current.map((command) => ({
      ...command,
      run: () => latest.current.find((c) => c.id === command.id)?.run(),
    }));
    shell?.setCommands(stable);
    return () => shell?.setCommands([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
