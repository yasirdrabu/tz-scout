import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll, migrationsFolder } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';

/** The routing migrations up to and including `lastTag`, as their own folder. */
function routingUpTo(lastTag: string): string {
  const real = migrationsFolder('routing');
  const journal = JSON.parse(readFileSync(path.join(real, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const keep = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-routing-'));
  mkdirSync(path.join(dir, 'meta'));
  for (const e of keep) copyFileSync(path.join(real, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  return dir;
}

describe('routing 0002: the seeded statuses and reasons of existing tenants (Decision 2, Open question 1)', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let sql: postgres.Sql;
  beforeAll(async () => {
    db = await freshDatabase(`scout_test_${process.pid}_routing_seed`);
    await migrateAll({ adminUrl: db.adminUrl, folders: { routing: routingUpTo('0001_review_merge_and_ownership') } });
    sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
    // A tenant seeded before the change, with one status label someone had already changed.
    for (const [key, label, order, reviewed, declined, initial, tone] of [
      ['unvetted', 'Unvetted', 1, false, false, true, 'neutral'],
      ['needs_review', 'Looking at it', 2, false, false, false, 'near'],
      ['reviewed', 'Reviewed', 3, true, false, false, 'good'],
      ['declined', 'Declined', 4, true, true, false, 'bad'],
    ] as const) {
      await sql`insert into routing.review_status_def (id, tenant_id, key, label, "order", counts_as_reviewed, is_declined, is_initial, tone)
        values (${`rsd_${key}`}, 't_old', ${key}, ${label}, ${order}, ${reviewed}, ${declined}, ${initial}, ${tone})`;
    }
    for (const [key, label, applies] of [['duplicate', 'Duplicate', 'review'], ['other', 'Other', 'both']] as const) {
      await sql`insert into routing.decline_reason_def (id, tenant_id, key, label, applies_to) values (${`drd_${key}`}, 't_old', ${key}, ${label}, ${applies})`;
    }
    await migrateAll({ adminUrl: db.adminUrl });
  });
  afterAll(async () => {
    await sql?.end();
    await db.drop();
  });

  it('renames the default labels, keeps a changed one, colors from the old tone and adds Sent back to source', async () => {
    const rows = await sql`select key, label, color, set_by, counts_as_reviewed, returns_to_source from routing.review_status_def where tenant_id = 't_old' order by "order"`;
    expect(rows.map((r) => [r.key, r.label, r.color, r.set_by])).toEqual([
      ['unvetted', 'Ready for review', 'plum', 'scout'],
      ['needs_review', 'Looking at it', 'amber', 'reviewer'],
      ['reviewed', 'Approved', 'green', 'reviewer'],
      ['declined', 'Not pursued', 'red', 'reviewer'],
      ['sent_back', 'Sent back to source', 'gray', 'reviewer'],
    ]);
    expect(rows[4]).toMatchObject({ counts_as_reviewed: true, returns_to_source: true });
    const tone = await sql`select 1 from information_schema.columns where table_schema = 'routing' and table_name = 'review_status_def' and column_name = 'tone'`;
    expect(tone).toHaveLength(0);
  });

  it('marks Other note required, keeps the decline reasons and adds the send-back reasons', async () => {
    const rows = await sql`select key, label, applies_to, note_required from routing.decline_reason_def where tenant_id = 't_old' order by "order", key`;
    expect(rows.map((r) => [r.key, r.applies_to, r.note_required])).toEqual([
      ['duplicate', 'review', false],
      ['other', 'both', true],
      ['not_our_kind_of_customer', 'send_back', false],
      ['existing_customer', 'send_back', false],
      ['duplicate_account', 'send_back', false],
      ['bad_contact', 'send_back', false],
      ['wrong_practice', 'send_back', false],
    ]);
  });
});
