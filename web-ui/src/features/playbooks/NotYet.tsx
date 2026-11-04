import table from '../../ui/Table.module.css';

/** A number Scout cannot give yet (rates arrive with the results release): a dash that reads as "not yet". */
export function NotYet() {
  return (
    <span className={table.muted}>
      —<span className="sr-only"> Not available yet</span>
    </span>
  );
}
