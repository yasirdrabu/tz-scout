import { cx } from '../../lib/cx';
import { useFormat } from '../../lib/useFormat';
import type { NextStep } from './api';
import styles from './Accounts.module.css';

/** The due words: "Due today" (amber), "{n} days overdue" (red), else the date. */
export function DueWords({ step, className }: { step: NextStep; className?: string }) {
  const f = useFormat();
  const late = step.overdue ? Math.max(1, f.daysSince(step.due_date)) : 0;
  const text = step.due_today ? 'Due today' : step.overdue ? (late === 1 ? '1 day overdue' : `${late} days overdue`) : f.day(step.due_date);
  return <span className={cx(className, step.due_today && styles.dueToday, step.overdue && !step.due_today && styles.overdue)}>{text}</span>;
}
