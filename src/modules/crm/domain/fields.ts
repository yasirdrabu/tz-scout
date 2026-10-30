export type FieldMappingRow = {
  scoutField: string;
  crmProperty: string;
  direction?: string;
  transform: string;
  transformConfig?: Record<string, string> | null;
  enabled?: boolean;
};

export type ScoutValue = string | number | Date | null | undefined;

const empty = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && !Number.isFinite(v));

function dateOnly(v: Date | string): string | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function transformed(row: FieldMappingRow, value: ScoutValue, now: Date): string | number | null {
  // The handoff date is Scout's own moment, so a mapped `last_handoff` with no value means now.
  const v = value === undefined && row.scoutField === 'last_handoff' ? now : value;
  if (empty(v)) return null;
  switch (row.transform) {
    case 'cents_to_amount': {
      const n = Number(v);
      return Number.isFinite(n) ? n / 100 : null;
    }
    case 'date':
      return dateOnly(v as Date | string);
    case 'enum_map':
      return row.transformConfig?.[String(v)] ?? null;
    default:
      return v instanceof Date ? v.toISOString() : (v as string | number);
  }
}

/** What to write to the CRM: pushed, enabled mappings only; empty values and properties the CRM does not have are left out. */
export function propertyValues(
  mappings: readonly FieldMappingRow[],
  values: Record<string, ScoutValue>,
  existing: ReadonlySet<string>,
  now: Date,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const row of mappings) {
    if (row.enabled === false || (row.direction ?? 'push') !== 'push') continue;
    if (!existing.has(row.crmProperty)) continue;
    const v = transformed(row, values[row.scoutField], now);
    if (v != null && !empty(v)) out[row.crmProperty] = v;
  }
  return out;
}
