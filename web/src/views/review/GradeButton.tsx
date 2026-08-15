import { interval } from '../../components/bits';

export function GradeButton({
  tone,
  label,
  days,
  n,
  onClick,
}: {
  tone: 'again' | 'hard' | 'good' | 'easy';
  label: string;
  days: number | undefined;
  n: number;
  onClick: () => void;
}) {
  return (
    <button className={tone} onClick={onClick}>
      <b>{label}</b>
      <small>{days === undefined ? '—' : interval(days)}</small>
      <span className="n">{n}</span>
    </button>
  );
}
