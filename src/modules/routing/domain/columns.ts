// The review queue's columns (screens.md §2): Account is always shown; the rest can be shown, hidden and reordered per person.

export const QUEUE_COLUMNS = [
  { key: 'best_offer', label: 'Best offer', shown: true },
  { key: 'priority', label: 'Priority', shown: true },
  { key: 'tier', label: 'Tier', shown: true },
  { key: 'source', label: 'Source', shown: true },
  { key: 'review_status', label: 'Review status', shown: true },
  { key: 'flags', label: 'Flags', shown: true },
  { key: 'notes', label: 'Notes', shown: true },
  { key: 'practice', label: 'Practice', shown: false },
  { key: 'fit', label: 'Fit', shown: false },
  { key: 'intent', label: 'Buying intent', shown: false },
  { key: 'arrived', label: 'Arrived', shown: false },
] as const;

export type ColumnChoice = { key: string; visible: boolean };
export type ColumnsView = {
  columns: { key: string; label: string; visible: boolean }[];
  /** "Columns {shown} of {total}", Account included. */
  shown: number;
  total: number;
  isDefault: boolean;
};

const LABEL = new Map<string, string>(QUEUE_COLUMNS.map((c) => [c.key, c.label]));

/** What is wrong with a saved choice: every column once, in the order wanted. */
export function columnProblems(choice: ColumnChoice[]): string[] {
  const keys = choice.map((c) => c.key);
  const unknown = keys.filter((k) => !LABEL.has(k));
  if (unknown.length) return [`There is no column called ${unknown[0]}.`];
  if (new Set(keys).size !== keys.length || keys.length !== QUEUE_COLUMNS.length) return ['List every column once.'];
  return [];
}

/** The columns as the popover shows them: the saved choice when it is still valid, else the default. */
export function columnsView(stored: unknown): ColumnsView {
  const valid = Array.isArray(stored) && stored.every((c) => c && typeof c.key === 'string' && typeof c.visible === 'boolean') && columnProblems(stored).length === 0;
  const columns = valid ? (stored as ColumnChoice[]).map((c) => ({ key: c.key, label: LABEL.get(c.key)!, visible: c.visible })) : QUEUE_COLUMNS.map((c) => ({ key: c.key, label: c.label, visible: c.shown }));
  return { columns, shown: 1 + columns.filter((c) => c.visible).length, total: 1 + QUEUE_COLUMNS.length, isDefault: !valid };
}
