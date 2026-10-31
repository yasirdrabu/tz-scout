import { ChevronDown, ChevronRight, Filter, X } from 'lucide-react';
import { useId, useState } from 'react';
import { cx } from '../lib/cx';
import styles from './FilterPopover.module.css';
import { Popover } from './Popover';

/** One option and how many rows it would show; the count comes from the API. */
export type FilterOption = { value: string; label: string; count?: number };

/** A category: `one` is a radio (pick one), `any` a checkbox (pick any). */
export type FilterCategory = { key: string; label: string; pick: 'one' | 'any'; options: FilterOption[] };

export type FilterValue = Record<string, string[]>;

export type FilterPopoverProps = {
  categories: FilterCategory[];
  value: FilterValue;
  onChange: (key: string, values: string[]) => void;
  onClear: () => void;
};

const plural = (n: number) => (n === 1 ? '1 filter on' : `${n} filters on`);

/**
 * The shared Filter (screens.md, Filter popover): a "Filter" button with a count, categories on the
 * left with what each has picked, options with counts on the right, "{n} filters on" and `Clear all`.
 * The active filters show beside it as pills "{Category} {value}": the pill opens its category, the x
 * removes it.
 */
export function FilterPopover({ categories, value, onChange, onClear }: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(categories[0]?.key ?? '');
  const base = useId();
  const picked = (key: string) => value[key] ?? [];
  const total = categories.reduce((n, c) => n + picked(c.key).length, 0);
  const current = categories.find((c) => c.key === active) ?? categories[0];
  const labelOf = (c: FilterCategory, v: string) => c.options.find((o) => o.value === v)?.label ?? v;

  function toggle(c: FilterCategory, v: string) {
    const now = picked(c.key);
    if (c.pick === 'one') onChange(c.key, now.includes(v) ? [] : [v]);
    else onChange(c.key, now.includes(v) ? now.filter((x) => x !== v) : [...now, v]);
  }

  const reopen = (key: string) => {
    setActive(key);
    setOpen(true);
  };

  return (
    <div className={styles.bar}>
      <Popover
        label="Filters"
        open={open}
        onOpenChange={setOpen}
        className={styles.panel}
        trigger={
          <button type="button" className={cx(styles.trigger, total > 0 && styles.on)}>
            <Filter aria-hidden="true" className={styles.icon} />
            Filter
            {total > 0 && ' '}
            {total > 0 && (
              <span className={styles.badge}>
                {total}
                {' '}
                <span className="sr-only">on</span>
              </span>
            )}
            <ChevronDown aria-hidden="true" className={styles.chevron} />
          </button>
        }
      >
        <div className={styles.grid}>
          <div role="tablist" aria-orientation="vertical" aria-label="Filter by" className={styles.cats}>
            {categories.map((c) => {
              const n = picked(c.key).length;
              const selected = c.key === current?.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  id={`${base}-${c.key}`}
                  aria-selected={selected}
                  aria-controls={`${base}-panel`}
                  className={styles.cat}
                  onClick={() => setActive(c.key)}
                  onMouseEnter={() => setActive(c.key)}
                >
                  <span className={styles.grow}>{c.label}</span>
                  {n > 0 && ' '}
                  {n > 0 && (
                    <span className={styles.catBadge}>
                      {n}
                      {' '}
                      <span className="sr-only">picked</span>
                    </span>
                  )}
                  <ChevronRight aria-hidden="true" className={styles.chevron} />
                </button>
              );
            })}
          </div>
          {current && (
            <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${current.key}`} className={styles.options}>
              <fieldset className={styles.fieldset}>
                <legend className={styles.legend}>
                  {current.label} · {current.pick === 'one' ? 'pick one' : 'pick any'}
                </legend>
                {current.options.length === 0 && <p className={styles.none}>Nothing to pick yet.</p>}
                {current.options.map((o) => {
                  const checked = picked(current.key).includes(o.value);
                  return (
                    <label key={o.value} className={cx(styles.option, checked && styles.checked)}>
                      <input
                        type={current.pick === 'one' ? 'radio' : 'checkbox'}
                        name={`${base}-${current.key}`}
                        checked={checked}
                        onChange={() => toggle(current, o.value)}
                        // A radio fires no change when it is already on, so a click on it clears the pick.
                        onClick={() => current.pick === 'one' && checked && toggle(current, o.value)}
                        className={styles.input}
                      />
                      <span className={styles.grow}>{o.label}</span>
                      {o.count !== undefined && ' '}
                      {o.count !== undefined && <span className={styles.count}>{o.count}</span>}
                    </label>
                  );
                })}
              </fieldset>
            </div>
          )}
          <div className={styles.foot}>
            <span>{total > 0 ? plural(total) : 'Nothing filtered yet'}</span>
            <button type="button" className={styles.link} onClick={onClear} disabled={total === 0}>
              Clear all
            </button>
          </div>
        </div>
      </Popover>
      {categories.flatMap((c) =>
        picked(c.key).map((v) => {
          const text = `${c.label} ${labelOf(c, v)}`;
          return (
            <span key={`${c.key}:${v}`} className={styles.pill}>
              <button type="button" className={styles.pillOpen} onClick={() => reopen(c.key)} aria-label={`Change ${text}`}>
                <span className={styles.pillCat}>{c.label}</span>
                <span className={styles.pillValue}>{labelOf(c, v)}</span>
              </button>
              <button type="button" className={styles.pillRemove} aria-label={`Remove ${text}`} onClick={() => onChange(c.key, picked(c.key).filter((x) => x !== v))}>
                <X aria-hidden="true" />
              </button>
            </span>
          );
        }),
      )}
      {total > 0 && (
        <button type="button" className={styles.link} onClick={onClear}>
          Clear all
        </button>
      )}
    </div>
  );
}
