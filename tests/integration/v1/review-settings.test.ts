import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as patchReviewStatus } from '@/http/routes/v1/accounts/[id]/review-status/route';
import { GET as getStatus } from '@/http/routes/v1/accounts/[id]/status/route';
import { POST as bulkRoute } from '@/http/routes/v1/review-queue/bulk/route';
import { GET as facetsRoute } from '@/http/routes/v1/review-queue/facets/route';
import { GET as queueRoute } from '@/http/routes/v1/review-queue/route';
import { GET as getReasons, PUT as putReasons } from '@/http/routes/v1/settings/review/reasons/route';
import { GET as getSettings, PUT as putSettings } from '@/http/routes/v1/settings/review/route';
import { GET as getStatuses, PUT as putStatuses } from '@/http/routes/v1/settings/review/statuses/route';
import { POST as settingAction } from '@/http/routes/v1/settings/[setting]/route';
import { statusChange } from '@/modules/routing/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { summaryOf } from '../routing/helpers';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
let otherAccount: string;

type Status = { key: string; label: string; color: string; description: string; set_by: string; flag_after_hours: number | null; archived: boolean; in_status_count: number | null; late_count: number | null };
type Reason = { key: string; label: string; applies_to: string; note_required: boolean; archived: boolean; used_this_quarter: number | null };

const statuses = async (who = w.owner): Promise<Status[]> => (await (await w.as(who, getStatuses, 'settings/review/statuses')).json()).data;
const reasons = async (who = w.owner): Promise<Reason[]> => (await (await w.as(who, getReasons, 'settings/review/reasons')).json()).data;
/** The list as the editor sends it back. */
const asEdits = (list: Status[]) => list.map((s) => ({ key: s.key, label: s.label, color: s.color, description: s.description, set_by: s.set_by, flag_after_hours: s.flag_after_hours, archived: s.archived }));
const reasonEdits = (list: Reason[]) => list.map((r) => ({ key: r.key, label: r.label, applies_to: r.applies_to, note_required: r.note_required, archived: r.archived }));
const sendBack = (accountId: string, body: Record<string, unknown>, who = leader) => w.as(who, patchReviewStatus, `accounts/${accountId}/review-status`, 'PATCH', { to: 'sent_back', ...body });

beforeAll(async () => {
  w = await workspace('Settings Co');
  other = await workspace('Other Co');
  leader = await w.person('leader', { name: 'Dana Leader' });
  seller = await w.person('seller');
  otherAccount = await other.account('Elsewhere Co');
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('GET /settings/review/statuses and /reasons', () => {
  it('lists the seeded statuses in the mockup words, with counts for settings:manage only', async () => {
    const a = await w.account('Count Co');
    const list = await statuses();
    expect(list.map((s) => [s.key, s.label, s.color, s.set_by, s.flag_after_hours])).toEqual([
      ['unvetted', 'Ready for review', 'plum', 'scout', 48],
      ['needs_review', 'In review', 'amber', 'reviewer', 24],
      ['reviewed', 'Approved', 'green', 'reviewer', null],
      ['declined', 'Not pursued', 'red', 'reviewer', null],
      ['sent_back', 'Sent back to source', 'gray', 'reviewer', null],
    ]);
    expect(list[4]).toMatchObject({ counts_as_reviewed: true, returns_to_source: true, is_final: true, required: true, archived: false });
    expect(list[1]).toMatchObject({ required: false, is_final: false });
    expect(list[0]!.in_status_count).toBeGreaterThanOrEqual(1);
    expect(list[0]!.late_count).toBe(0);
    const forLeader = await statuses(leader);
    expect(forLeader.map((s) => s.key)).toEqual(list.map((s) => s.key));
    expect(forLeader[0]).toMatchObject({ in_status_count: null, late_count: null });
    expect((await w.as(seller, getStatuses, 'settings/review/statuses')).status).toBe(200);
    expect(a).toBeTruthy();
  });

  it('lists every reason with its list, note required and order', async () => {
    const list = await reasons();
    const sendBackList = list.filter((r) => r.applies_to === 'send_back').map((r) => r.label);
    expect(sendBackList).toEqual(['Not our kind of customer', 'Already a customer', 'Duplicate of another account', 'Bad or missing contact', 'Wrong practice']);
    expect(list.find((r) => r.key === 'other')).toMatchObject({ applies_to: 'both', note_required: true });
    expect(list.find((r) => r.key === 'not_my_territory')).toMatchObject({ applies_to: 'assignment', note_required: false });
    expect(list[0]!.used_this_quarter).toBe(0);
    expect((await reasons(seller))[0]!.used_this_quarter).toBeNull();
  });

  it('refuses a caller with none of review:act, assignments:respond or settings:manage', async () => {
    const key = await keyFor(w.tenant, ['accounts:read']);
    expect((await call(getStatuses, key, 'settings/review/statuses')).status).toBe(403);
    expect((await call(getReasons, key, 'settings/review/reasons')).status).toBe(403);
  });

  it('the settings read carries the same statuses and every reason', async () => {
    const body = await (await w.as(w.owner, getSettings, 'settings/review')).json();
    expect(body.statuses.map((s: Status) => s.label)).toEqual(['Ready for review', 'In review', 'Approved', 'Not pursued', 'Sent back to source']);
    expect(body.decline_reasons.some((r: Reason) => r.applies_to === 'send_back')).toBe(true);
  });
});

describe('PUT /settings/review/statuses (Decision 2)', () => {
  it('renames, recolors, reorders and adds a status; audited', async () => {
    const list = await statuses();
    const edits = asEdits(list);
    edits[0] = { ...edits[0]!, label: 'New', color: 'amber', flag_after_hours: 12 };
    const added = { key: null, label: 'Waiting on legal', color: 'red', description: 'Legal has to clear it.', set_by: 'reviewer', flag_after_hours: 72, archived: false };
    const res = await w.as(w.owner, putStatuses, 'settings/review/statuses', 'PUT', { statuses: [edits[0], added, ...edits.slice(1)] });
    expect(res.status).toBe(200);
    const saved: Status[] = (await res.json()).data;
    expect(saved.map((s) => s.label)).toEqual(['New', 'Waiting on legal', 'In review', 'Approved', 'Not pursued', 'Sent back to source']);
    expect(saved[1]).toMatchObject({ key: 'waiting_on_legal', color: 'red', description: 'Legal has to clear it.', flag_after_hours: 72, in_status_count: 0 });
    const [entry] = await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, 'routing.statuses.updated')));
    expect(entry).toBeDefined();
    // The queue shows the new name.
    await w.account('Renamed Co');
    const queue = await (await w.as(leader, queueRoute, 'review-queue')).json();
    expect(queue.data[0].review_status_label).toBe('New');
  });

  it('archiving a status moves its accounts to the first status', async () => {
    const a = await w.account('Legal Co');
    expect((await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'waiting_on_legal' })).status).toBe(200);
    await w.deliver();
    expect((await summaryOf(w.tenant, a)).reviewStatusKey).toBe('waiting_on_legal');
    const edits = asEdits(await statuses()).map((s) => (s.key === 'waiting_on_legal' ? { ...s, archived: true } : s));
    const res = await w.as(w.owner, putStatuses, 'settings/review/statuses', 'PUT', { statuses: edits });
    expect(res.status).toBe(200);
    expect((await res.json()).data.find((s: Status) => s.key === 'waiting_on_legal')).toMatchObject({ archived: true, in_status_count: 0 });
    await w.deliver();
    expect((await summaryOf(w.tenant, a)).reviewStatusKey).toBe('unvetted');
    const moves = await w.run((ctx) => ctx.tx.select().from(statusChange).where(eq(statusChange.accountId, a)));
    expect(moves.map((m) => [m.fromKey, m.toKey, m.note])).toContainEqual(['waiting_on_legal', 'unvetted', 'Waiting on legal was archived.']);
  });

  it('refuses archiving a status Scout needs, removing one, and bad fields, with plain messages', async () => {
    const edits = asEdits(await statuses());
    const put = (body: unknown, who = w.owner) => w.as(who, putStatuses, 'settings/review/statuses', 'PUT', body);
    const archiveRequired = await put({ statuses: edits.map((s) => (s.key === 'sent_back' ? { ...s, archived: true } : s)) });
    expect(archiveRequired.status).toBe(400);
    expect((await archiveRequired.json()).errors).toEqual([{ path: expect.stringMatching(/^statuses\.\d+\.archived$/), message: "Sent back to source can't be archived. Scout needs it." }]);
    const removed = await put({ statuses: edits.filter((s) => s.key !== 'needs_review') });
    expect((await removed.json()).title).toBe('Archive In review instead of removing it.');
    expect((await put({ statuses: edits.map((s) => (s.key === 'needs_review' ? { ...s, color: 'pink' } : s)) })).status).toBe(400);
    expect((await put({ statuses: 'none' })).status).toBe(400);
  });

  it('only settings:manage, only people', async () => {
    const edits = asEdits(await statuses());
    expect((await w.as(leader, putStatuses, 'settings/review/statuses', 'PUT', { statuses: edits })).status).toBe(403);
    const key = await keyFor(w.tenant, ['settings:manage']);
    expect((await call(putStatuses, key, 'settings/review/statuses', { method: 'PUT', body: { statuses: edits } })).status).toBe(403);
  });

  it("another tenant's statuses are not in the list, and their keys can't be saved", async () => {
    const theirs = asEdits((await (await other.as(other.owner, getStatuses, 'settings/review/statuses')).json()).data);
    const added = await other.as(other.owner, putStatuses, 'settings/review/statuses', 'PUT', { statuses: [...theirs, { label: 'Their own', color: 'gray', set_by: 'reviewer', flag_after_hours: null }] });
    expect(added.status).toBe(200);
    expect((await statuses()).some((s) => s.key === 'their_own')).toBe(false);
    const res = await w.as(w.owner, putStatuses, 'settings/review/statuses', 'PUT', { statuses: [...asEdits(await statuses()), { key: 'their_own', label: 'Theirs', color: 'gray', set_by: 'reviewer', flag_after_hours: null }] });
    expect(res.status).toBe(400);
  });
});

describe('PUT /settings/review/reasons', () => {
  it('adds a reason and marks one note required; send back then needs the note', async () => {
    const list = reasonEdits(await reasons());
    const edits = list.map((r) => (r.key === 'bad_contact' ? { ...r, note_required: true } : r));
    const res = await w.as(w.owner, putReasons, 'settings/review/reasons', 'PUT', { reasons: [...edits, { label: 'Missing website', applies_to: 'send_back', note_required: false }] });
    expect(res.status).toBe(200);
    const saved: Reason[] = (await res.json()).data;
    expect(saved.find((r) => r.key === 'missing_website')).toMatchObject({ applies_to: 'send_back', note_required: false, archived: false });
    const a = await w.account('Contact Co');
    const noNote = await sendBack(a, { reason_key: 'bad_contact' });
    expect(noNote.status).toBe(400);
    expect(await noNote.json()).toMatchObject({ title: 'Say what the source should fix.', errors: [{ path: 'note', message: 'Say what the source should fix.' }] });
    expect((await sendBack(a, { reason_key: 'bad_contact', note: 'The email bounces.' })).status).toBe(200);
  });

  it('keeps one reason per list and refuses a bad list; settings:manage only', async () => {
    const list = reasonEdits(await reasons());
    const noSendBack = await w.as(w.owner, putReasons, 'settings/review/reasons', 'PUT', { reasons: list.map((r) => (r.applies_to === 'send_back' ? { ...r, archived: true } : r)) });
    expect(noSendBack.status).toBe(400);
    expect((await noSendBack.json()).errors).toContainEqual({ path: 'reasons', message: 'Keep at least one send-back reason.' });
    expect((await w.as(w.owner, putReasons, 'settings/review/reasons', 'PUT', { reasons: [{ label: 'X', applies_to: 'review' }] })).status).toBe(400);
    expect((await w.as(leader, putReasons, 'settings/review/reasons', 'PUT', { reasons: list })).status).toBe(403);
  });
});

describe('POST /settings/review:reset', () => {
  it('restores the default words and archives what the tenant added', async () => {
    const res = await w.as(w.owner, settingAction, 'settings/review:reset', 'POST', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const live = body.statuses.filter((s: Status) => !s.archived);
    expect(live.map((s: Status) => s.label)).toEqual(['Ready for review', 'In review', 'Approved', 'Not pursued', 'Sent back to source']);
    expect(body.statuses.find((s: Status) => s.key === 'waiting_on_legal')).toMatchObject({ archived: true });
    expect(body.decline_reasons.find((r: Reason) => r.key === 'missing_website')).toMatchObject({ archived: true });
    expect(body.decline_reasons.find((r: Reason) => r.key === 'bad_contact')).toMatchObject({ note_required: false });
    expect(body.auto_accept_working_days).toBe(2);
    expect((await w.as(leader, settingAction, 'settings/review:reset', 'POST', {})).status).toBe(403);
    expect((await w.as(w.owner, settingAction, 'settings/review:nope', 'POST', {})).status).toBe(404);
  });
});

describe('send back with a reason (Decision 1)', () => {
  it('needs a send-back reason; the note is optional; it leaves the queue and keeps the stage', async () => {
    const a = await w.account('Back Co');
    const none = await sendBack(a, { note: 'Fix it' });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ title: 'Pick a reason', errors: [{ path: 'reason_key', message: 'Pick a reason' }] });
    expect((await sendBack(a, { reason_key: 'not_a_fit' })).status).toBe(400);
    const ok = await sendBack(a, { reason_key: 'wrong_practice' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ review_status_key: 'sent_back', stage: 'arrived' });
    await w.deliver();
    const [move] = await w.run((ctx) => ctx.tx.select().from(statusChange).where(and(eq(statusChange.accountId, a), eq(statusChange.toKey, 'sent_back'))));
    expect(move).toMatchObject({ reasonKey: 'wrong_practice', note: null });
    const queue = await (await w.as(leader, queueRoute, 'review-queue')).json();
    expect(queue.data.map((r: { account_id: string }) => r.account_id)).not.toContain(a);
    expect((await (await w.as(leader, getStatus, `accounts/${a}/status`)).json()).summary).toBe('Sent back to the source.');
    expect((await reasons()).find((r) => r.key === 'wrong_practice')!.used_this_quarter).toBeGreaterThanOrEqual(1);
  });

  it('a seller cannot send back, and an account in another tenant is a 404', async () => {
    const a = await w.account('Seller Co');
    expect((await sendBack(a, { reason_key: 'wrong_practice' }, seller)).status).toBe(403);
    expect((await sendBack(otherAccount, { reason_key: 'wrong_practice' })).status).toBe(404);
  });

  it('bulk: one reason and note for each account, with a result per account', async () => {
    const [a, b] = [await w.account('Bulk A'), await w.account('Bulk B')];
    const missing = await w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b], action: 'status', to: 'sent_back' });
    expect(missing.status).toBe(200);
    expect((await missing.json()).results).toEqual([
      { account_id: a, ok: false, status: 400, message: 'Pick a reason' },
      { account_id: b, ok: false, status: 400, message: 'Pick a reason' },
    ]);
    const res = await w.as(leader, bulkRoute, 'review-queue/bulk', 'POST', { account_ids: [a, b, otherAccount], action: 'status', to: 'sent_back', reason_key: 'duplicate_account', note: 'Merge first.' });
    expect((await res.json()).results).toEqual([
      { account_id: a, ok: true },
      { account_id: b, ok: true },
      { account_id: otherAccount, ok: false, status: 404, message: 'That account was not found.' },
    ]);
    await w.deliver();
    for (const id of [a, b]) expect((await summaryOf(w.tenant, id)).reviewStatusKey).toBe('sent_back');
    const moves = await w.run((ctx) => ctx.tx.select().from(statusChange).where(and(eq(statusChange.toKey, 'sent_back'), eq(statusChange.reasonKey, 'duplicate_account'))));
    expect(moves.map((m) => m.note)).toEqual(['Merge first.', 'Merge first.']);
  });
});

describe('PUT /settings/review: statuses, reasons and auto-accept in one save (Ruling 19)', () => {
  type Settings = { statuses: Status[]; decline_reasons: Reason[]; auto_accept_working_days: number | null; version: number };
  const settings = async (who = w.owner, ws = w): Promise<Settings> => (await ws.as(who, getSettings, 'settings/review')).json();
  /** A save from a fresh load: the current version goes with it unless the body names one. */
  const save = async (body: Record<string, unknown>, who = w.owner, ws = w) =>
    ws.as(who, putSettings, 'settings/review', 'PUT', 'version' in body ? body : { ...body, version: (await settings(ws.owner, ws)).version });
  const audits = async (action: string) => (await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, action)))).length;
  const auditCounts = async () => [await audits('routing.statuses.updated'), await audits('routing.reasons.updated'), await audits('routing.settings.updated')];

  it('a bad reason in the same save leaves the statuses and auto-accept as they were, and audits nothing', async () => {
    const before = await settings();
    const counts = await auditCounts();
    const statusEdits = asEdits(before.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: 'Checking' } : s));
    const reasonList = reasonEdits(before.decline_reasons);
    reasonList[0] = { ...reasonList[0]!, label: ' ' };
    const res = await save({ statuses: statusEdits, reasons: reasonList, auto_accept_working_days: 7 });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([{ path: 'reasons.0.label', message: 'Give it a name.' }]);
    const after = await settings();
    expect(after.statuses.find((s) => s.key === 'needs_review')!.label).toBe('In review');
    expect(after.decline_reasons[0]!.label).toBe(before.decline_reasons[0]!.label);
    expect(after.auto_accept_working_days).toBe(before.auto_accept_working_days);
    expect(await auditCounts()).toEqual(counts);
  });

  it('reports the problems of every part at their paths', async () => {
    const before = await settings();
    const statusEdits = asEdits(before.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: '' } : s));
    const reasonList = reasonEdits(before.decline_reasons).map((r) => (r.applies_to === 'send_back' ? { ...r, archived: true } : r));
    const res = await save({ statuses: statusEdits, reasons: reasonList, auto_accept_working_days: 11 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.title).toBe('Give it a name.');
    expect(body.errors).toEqual([
      { path: 'statuses.1.label', message: 'Give it a name.' },
      { path: 'reasons', message: 'Keep at least one send-back reason.' },
      { path: 'auto_accept_working_days', message: 'Pick 1 to 10 working days, or turn it off.' },
    ]);
  });

  it.each([
    ['archiving a status Scout needs', (s: Status) => (s.key === 'sent_back' ? { archived: true } : {}), "Sent back to source can't be archived. Scout needs it."],
    ['flagging a final status', (s: Status) => (s.key === 'reviewed' ? { flag_after_hours: 5 } : {}), 'Approved is final, so it is never flagged.'],
    ['flag after out of range', (s: Status) => (s.key === 'needs_review' ? { flag_after_hours: 721 } : {}), 'Flag after 1 to 720 hours, or never.'],
    ['an unknown color', (s: Status) => (s.key === 'needs_review' ? { color: 'pink' } : {}), 'Pick plum, amber, green, red or gray.'],
    ['an unknown set by', (s: Status) => (s.key === 'needs_review' ? { set_by: 'robot' } : {}), 'Pick Scout or a reviewer.'],
  ])('refuses %s', async (_name, change, message) => {
    const edits = asEdits((await settings()).statuses).map((s) => ({ ...s, ...change(s as Status) }));
    const res = await save({ statuses: edits });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].message).toBe(message);
  });

  it('refuses removing a status from the list, and an empty save', async () => {
    const edits = asEdits((await settings()).statuses).filter((s) => s.key !== 'needs_review');
    expect((await (await save({ statuses: edits })).json()).title).toBe('Archive In review instead of removing it.');
    const empty = await save({});
    expect(empty.status).toBe(400);
    expect((await empty.json()).title).toBe('Nothing to save.');
  });

  it('a good save changes all three; the queue facets and the send-back reasons show them; one audit row per part', async () => {
    const counts = await auditCounts();
    const before = await settings();
    const statusEdits = asEdits(before.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: 'Being checked', color: 'green' } : s));
    const res = await save({
      statuses: statusEdits,
      reasons: [...reasonEdits(before.decline_reasons), { label: 'Wrong region', applies_to: 'send_back', note_required: false }],
      auto_accept_working_days: 4,
    });
    expect(res.status).toBe(200);
    const saved: Settings = await res.json();
    expect(saved.statuses.find((s) => s.key === 'needs_review')).toMatchObject({ label: 'Being checked', color: 'green', in_status_count: expect.any(Number) });
    expect(saved.decline_reasons.find((r) => r.key === 'wrong_region')).toMatchObject({ applies_to: 'send_back', note_required: false, used_this_quarter: 0 });
    expect(saved.auto_accept_working_days).toBe(4);
    const facets = await (await w.as(leader, facetsRoute, 'review-queue/facets')).json();
    expect(facets.statuses.find((s: { value: string }) => s.value === 'needs_review')).toMatchObject({ label: 'Being checked', color: 'green' });
    expect((await reasons(leader)).filter((r) => r.applies_to === 'send_back').map((r) => r.label)).toContain('Wrong region');
    expect(await auditCounts()).toEqual(counts.map((n) => n + 1));
  });

  it('archiving a status in the save moves its accounts to the first status', async () => {
    const before = await settings();
    const added = await save({ statuses: [...asEdits(before.statuses), { label: 'On hold', color: 'gray', set_by: 'reviewer', flag_after_hours: null }] });
    expect(added.status).toBe(200);
    const a = await w.account('Hold Co');
    expect((await w.as(leader, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'on_hold' })).status).toBe(200);
    await w.deliver();
    const archived = await save({ statuses: asEdits((await settings()).statuses).map((s) => (s.key === 'on_hold' ? { ...s, archived: true } : s)) });
    expect(archived.status).toBe(200);
    expect((await archived.json()).statuses.find((s: Status) => s.key === 'on_hold')).toMatchObject({ archived: true, in_status_count: 0 });
    await w.deliver();
    expect((await summaryOf(w.tenant, a)).reviewStatusKey).toBe('unvetted');
  });

  it('a save from an older load is a 409 and writes nothing; every write bumps the version', async () => {
    const loaded = await settings();
    // Another owner saves in between, through the older statuses route.
    const renamed = asEdits(loaded.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: 'Theirs first' } : s));
    expect((await w.as(w.owner, putStatuses, 'settings/review/statuses', 'PUT', { statuses: renamed })).status).toBe(200);
    const after = await settings();
    expect(after.version).toBeGreaterThan(loaded.version);
    const counts = await auditCounts();
    const mine = asEdits(loaded.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: 'Mine' } : s));
    const res = await save({ statuses: mine, auto_accept_working_days: 8, version: loaded.version });
    expect(res.status).toBe(409);
    expect((await res.json()).title).toBe('Someone else changed these. Reload to see their changes.');
    const now = await settings();
    expect(now.statuses.find((s) => s.key === 'needs_review')!.label).toBe('Theirs first');
    expect(now.auto_accept_working_days).toBe(after.auto_accept_working_days);
    expect(now.version).toBe(after.version);
    expect(await auditCounts()).toEqual(counts);
    // The reasons route, the one save and the reset bump it too.
    expect((await w.as(w.owner, putReasons, 'settings/review/reasons', 'PUT', { reasons: reasonEdits(now.decline_reasons) })).status).toBe(200);
    const v1 = (await settings()).version;
    expect(v1).toBeGreaterThan(now.version);
    const ok = await save({ auto_accept_working_days: 3, version: v1 });
    expect(ok.status).toBe(200);
    const v2 = (await ok.json()).version;
    expect(v2).toBeGreaterThan(v1);
    const reset = await w.as(w.owner, settingAction, 'settings/review:reset', 'POST', {});
    expect((await reset.json()).version).toBeGreaterThan(v2);
  });

  it('the version is required', async () => {
    const res = await w.as(w.owner, putSettings, 'settings/review', 'PUT', { auto_accept_working_days: 3 });
    expect(res.status).toBe(400);
  });

  it('settings:manage people only', async () => {
    const edits = asEdits((await settings()).statuses);
    expect((await save({ statuses: edits }, leader)).status).toBe(403);
    const key = await keyFor(w.tenant, ['settings:manage']);
    expect((await call(putSettings, key, 'settings/review', { method: 'PUT', body: { statuses: edits, version: 0 } })).status).toBe(403);
  });

  it("another tenant's status keys can't be saved here, and their save leaves this tenant alone", async () => {
    const theirs = await settings(other.owner, other);
    const mine = await settings();
    const their = asEdits(theirs.statuses).find((s) => s.key === 'their_own')!;
    const res = await save({ statuses: [...asEdits(mine.statuses), { ...their, label: 'Stolen' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toMatch(/^statuses\.\d+\.key$/);
    const theirEdits = asEdits(theirs.statuses).map((s) => (s.key === 'needs_review' ? { ...s, label: 'Their review' } : s));
    expect((await save({ statuses: theirEdits, auto_accept_working_days: 9 }, other.owner, other)).status).toBe(200);
    const after = await settings();
    expect(after.statuses.find((s) => s.key === 'needs_review')!.label).toBe(mine.statuses.find((s) => s.key === 'needs_review')!.label);
    expect(after.auto_accept_working_days).toBe(mine.auto_accept_working_days);
  });
});
