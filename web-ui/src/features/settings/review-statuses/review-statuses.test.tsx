import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { ReviewSettings, ReviewSettingsSave, SettingsReason, SettingsStatus } from './api';

const status = (s: Partial<SettingsStatus> & Pick<SettingsStatus, 'key' | 'label' | 'order'>): SettingsStatus => ({
  color: 'gray',
  description: '',
  set_by: 'reviewer',
  flag_after_hours: null,
  is_initial: false,
  is_final: false,
  required: false,
  archived: false,
  in_status_count: 0,
  late_count: 0,
  ...s,
});

const reason = (r: Partial<SettingsReason> & Pick<SettingsReason, 'key' | 'label' | 'applies_to' | 'order'>): SettingsReason => ({
  note_required: false,
  archived: false,
  used_this_quarter: 0,
  ...r,
});

const SETTINGS: ReviewSettings = {
  statuses: [
    status({ key: 'unvetted', label: 'Ready for review', order: 1, color: 'plum', set_by: 'scout', flag_after_hours: 48, is_initial: true, required: true, in_status_count: 38, late_count: 5, description: 'Where new accounts land' }),
    status({ key: 'needs_review', label: 'In review', order: 2, color: 'amber', flag_after_hours: 24, in_status_count: 6, late_count: 1 }),
    status({ key: 'reviewed', label: 'Approved', order: 3, color: 'green', is_final: true, required: true, in_status_count: 214 }),
    status({ key: 'sent_back', label: 'Sent back to source', order: 4, is_final: true, required: true, in_status_count: 9 }),
    status({ key: 'old', label: 'Old step', order: 5, archived: true }),
  ],
  decline_reasons: [
    reason({ key: 'not_our_kind_of_customer', label: 'Not our kind of customer', applies_to: 'send_back', order: 1, used_this_quarter: 31 }),
    reason({ key: 'existing_customer', label: 'Already a customer', applies_to: 'send_back', order: 2, used_this_quarter: 12 }),
    reason({ key: 'not_a_fit', label: 'Not a fit', applies_to: 'review', order: 3 }),
    reason({ key: 'not_my_territory', label: 'Not my territory', applies_to: 'assignment', order: 4, used_this_quarter: 3 }),
  ],
  auto_accept_working_days: 2,
  colors: [
    { value: 'plum', label: 'Plum' },
    { value: 'amber', label: 'Amber' },
    { value: 'green', label: 'Green' },
    { value: 'red', label: 'Red' },
    { value: 'gray', label: 'Gray' },
  ],
};

let puts: ReviewSettingsSave[] = [];
let resets = 0;

function serve(opts: { put?: (body: ReviewSettingsSave) => Response | undefined } = {}) {
  puts = [];
  resets = 0;
  serveMe({ taazaa: { scopes: ['settings:manage'] } });
  server.use(
    http.get('/api/v1/settings/review', () => HttpResponse.json(SETTINGS)),
    http.put('/api/v1/settings/review', async ({ request }) => {
      const body = (await request.json()) as ReviewSettingsSave;
      puts.push(body);
      const answer = opts.put?.(body);
      if (answer) return answer;
      return HttpResponse.json({
        ...SETTINGS,
        statuses: body.statuses ? body.statuses.map((s, i) => status({ ...s, key: s.key ?? `new_${i}`, order: i + 1 } as SettingsStatus)) : SETTINGS.statuses,
        auto_accept_working_days: body.auto_accept_working_days === undefined ? SETTINGS.auto_accept_working_days : body.auto_accept_working_days,
      });
    }),
    http.post(exactly('/api/v1/settings/review:reset'), () => {
      resets++;
      return HttpResponse.json({ ...SETTINGS, statuses: SETTINGS.statuses.map((s) => (s.key === 'needs_review' ? { ...s, label: 'In review' } : s)) });
    }),
    http.get('/api/v1/ai-runs', () => HttpResponse.json({ data: [], totals: [] })),
  );
}

const open = async () => {
  renderApp('/t/taazaa/settings/review-statuses');
  return screen.findByRole('table');
};
const rowOf = (table: HTMLElement, name: string) => within(table).getByRole('textbox', { name: `Name of ${name}` }).closest('tr')!;
const saveButton = () => screen.getByRole('button', { name: 'Save statuses' });

beforeEach(() => localStorage.clear());

describe('Settings > Review statuses', () => {
  it('shows the intro, the live statuses with their counts, Final, and no Archive for the statuses Scout needs', async () => {
    serve();
    const table = await open();
    expect(screen.getByText(/The steps an account goes through in the review queue/)).toBeInTheDocument();
    expect(within(table).queryByRole('textbox', { name: 'Name of Old step' })).not.toBeInTheDocument();
    const ready = rowOf(table, 'Ready for review');
    expect(within(ready).getByText('Scout needs this status')).toBeInTheDocument();
    expect(within(ready).queryByRole('button', { name: 'Archive Ready for review' })).not.toBeInTheDocument();
    expect(within(ready).getByText('5 late')).toBeInTheDocument();
    expect(within(ready).getByRole('combobox', { name: 'Who sets Ready for review' })).toHaveDisplayValue('Scout, automatically');
    expect(within(ready).getByRole('spinbutton', { name: 'Flag Ready for review after how many hours' })).toHaveValue(48);
    const approved = rowOf(table, 'Approved');
    expect(within(approved).getByText('Final')).toBeInTheDocument();
    const inReview = rowOf(table, 'In review');
    expect(within(inReview).getByRole('button', { name: 'Archive In review' })).toBeInTheDocument();
    expect(within(within(inReview).getByRole('combobox', { name: 'Color for In review' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Plum', 'Amber', 'Green', 'Red', 'Gray']);
    expect(screen.getByText('31 this quarter')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('one PUT with the changed parts: a renamed and recolored status and a new send-back reason; then the toast', async () => {
    serve();
    const user = userEvent.setup();
    const table = await open();
    const inReview = rowOf(table, 'In review');
    await user.clear(within(inReview).getByRole('textbox', { name: 'Name of In review' }));
    await user.type(within(inReview).getByRole('textbox', { name: 'Name of In review' }), 'Being checked');
    await user.selectOptions(within(inReview).getByRole('combobox', { name: 'Color for In review' }), 'Green');
    await user.type(screen.getByRole('textbox', { name: 'Add a reason to Send-back reasons' }), 'Wrong region');
    const sendBack = screen.getByRole('region', { name: 'Send-back reasons' });
    await user.click(within(sendBack).getByRole('button', { name: 'Add' }));
    expect(within(sendBack).getByRole('textbox', { name: 'Name of the new reason' })).toHaveValue('Wrong region');
    await user.click(saveButton());
    expect(await screen.findByText('Review statuses saved. The review queue now shows them.')).toBeInTheDocument();
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0]!).sort()).toEqual(['reasons', 'statuses']);
    expect(puts[0]!.statuses![1]).toMatchObject({ key: 'needs_review', label: 'Being checked', color: 'green' });
    expect(puts[0]!.statuses!.map((s) => s.key)).toEqual(['unvetted', 'needs_review', 'reviewed', 'sent_back', 'old']);
    expect(puts[0]!.reasons!.at(-1)).toEqual({ key: null, label: 'Wrong region', applies_to: 'send_back', note_required: false, archived: false });
  });

  it('adds a status, edits what it means, who sets it and flag after, and reorders with the keyboard', async () => {
    serve();
    const user = userEvent.setup();
    const table = await open();
    await user.click(screen.getByRole('button', { name: 'Add status' }));
    const added = within(table).getByRole('textbox', { name: 'Name of the new status' });
    await user.type(added, 'Waiting on legal');
    const row = added.closest('tr')!;
    await user.type(within(row).getByRole('textbox', { name: 'What the new status means' }), 'Legal has to clear it.');
    await user.type(within(row).getByRole('spinbutton', { name: 'Flag the new status after how many hours' }), '72');
    await user.selectOptions(within(row).getByRole('combobox', { name: 'Who sets the new status' }), 'Scout, automatically');
    within(rowOf(table, 'In review')).getByRole('button', { name: 'Move In review down' }).focus();
    await user.keyboard('{Enter}');
    await user.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.statuses!.map((s) => s.label)).toEqual(['Ready for review', 'Approved', 'In review', 'Sent back to source', 'Waiting on legal', 'Old step']);
    expect(puts[0]!.statuses![4]).toEqual({ key: null, label: 'Waiting on legal', color: 'gray', description: 'Legal has to clear it.', set_by: 'scout', flag_after_hours: 72, archived: false });
    expect(puts[0]!.reasons).toBeUndefined();
  });

  it('archiving a status asks first, with its count and the first status, then saves it archived', async () => {
    serve();
    const user = userEvent.setup();
    const table = await open();
    await user.click(within(rowOf(table, 'In review')).getByRole('button', { name: 'Archive In review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive In review?' });
    expect(within(dialog).getByText('Its 6 accounts move to Ready for review.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(within(table).queryByRole('textbox', { name: 'Name of In review' })).not.toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.statuses!.find((s) => s.key === 'needs_review')).toMatchObject({ archived: true });
  });

  it('keeps at least one reason in a list', async () => {
    serve();
    const user = userEvent.setup();
    await open();
    const ae = screen.getByRole('region', { name: 'Decline reasons for AEs' });
    await user.click(within(ae).getByRole('button', { name: 'Archive Not my territory' }));
    expect(within(ae).getByRole('alert')).toHaveTextContent('Keep at least one decline reason for AEs.');
    expect(within(ae).getByRole('textbox', { name: 'Name of Not my territory' })).toBeInTheDocument();
    const sendBack = screen.getByRole('region', { name: 'Send-back reasons' });
    await user.click(within(sendBack).getByRole('button', { name: 'Archive Already a customer' }));
    expect(within(sendBack).queryByRole('textbox', { name: 'Name of Already a customer' })).not.toBeInTheDocument();
    await user.click(within(sendBack).getByRole('switch', { name: 'Note required for Not our kind of customer' }));
    await user.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.reasons!.find((r) => r.key === 'existing_customer')).toMatchObject({ archived: true });
    expect(puts[0]!.reasons!.find((r) => r.key === 'not_our_kind_of_customer')).toMatchObject({ note_required: true });
    expect(puts[0]!.reasons!.find((r) => r.key === 'not_a_fit')).toMatchObject({ archived: false });
  });

  it('shows the API errors at their rows, and keeps the edits', async () => {
    serve({
      put: () =>
        HttpResponse.json(
          {
            type: 'https://scout.taazaa.ai/problems/validation',
            title: 'Give it a name.',
            status: 400,
            errors: [
              { path: 'statuses.1.label', message: 'Give it a name.' },
              { path: 'reasons.1.label', message: 'Already a customer is in this list twice.' },
              { path: 'reasons', message: 'Keep at least one send-back reason.' },
            ],
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    const user = userEvent.setup();
    const table = await open();
    await user.clear(within(rowOf(table, 'In review')).getByRole('textbox', { name: 'Name of In review' }));
    await user.click(saveButton());
    const row = rowOf(table, 'In review');
    expect(await within(row).findByText('Give it a name.')).toBeInTheDocument();
    expect(within(row).getByRole('textbox', { name: 'Name of In review' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByRole('region', { name: 'Send-back reasons' })).getByText('Already a customer is in this list twice.')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('Keep at least one send-back reason.');
    expect(within(row).getByRole('textbox', { name: 'Name of In review' })).toHaveValue('');
  });

  it('Discard goes back to the loaded values', async () => {
    serve();
    const user = userEvent.setup();
    const table = await open();
    await user.type(within(rowOf(table, 'In review')).getByRole('textbox', { name: 'Name of In review' }), ' now');
    expect(saveButton()).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(within(table).getByRole('textbox', { name: 'Name of In review' })).toHaveValue('In review');
    expect(saveButton()).toBeDisabled();
    expect(puts).toHaveLength(0);
  });

  it('turns auto-accept off and changes the days', async () => {
    serve();
    const user = userEvent.setup();
    await open();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Working days before an assignment is accepted' }), '5');
    await user.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ auto_accept_working_days: 5 });
    await waitFor(() => expect(saveButton()).toBeDisabled());
    await user.click(screen.getByRole('switch', { name: /Accept assignments automatically after/ }));
    expect(screen.getByRole('combobox', { name: 'Working days before an assignment is accepted' })).toBeDisabled();
    await user.click(saveButton());
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ auto_accept_working_days: null });
  });

  it('Restore defaults asks first, then calls the reset', async () => {
    serve();
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore the default statuses and reasons?' });
    expect(within(dialog).getByText('Statuses and reasons you added are archived and their accounts move to Ready for review.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Restore defaults' }));
    await waitFor(() => expect(resets).toBe(1));
    expect(puts).toHaveLength(0);
  });

  it('leaving with unsaved changes asks first', async () => {
    serve();
    const user = userEvent.setup();
    const view = renderApp('/t/taazaa/settings/review-statuses');
    const table = await screen.findByRole('table');
    await user.type(within(rowOf(table, 'In review')).getByRole('textbox', { name: 'Name of In review' }), ' now');
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    await user.click(within(nav).getByRole('link', { name: 'AI runs' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(view.path()).toBe('/t/taazaa/settings/review-statuses');
    expect(within(table).getByRole('textbox', { name: 'Name of In review' })).toHaveValue('In review now');
    await user.click(within(nav).getByRole('link', { name: 'AI runs' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(view.path()).toBe('/t/taazaa/settings/ai-runs'));
  });

  it('the tab is not open without settings:manage', async () => {
    serveMe({ taazaa: { scopes: ['members:read'] } });
    server.use(http.get('/api/v1/members', () => HttpResponse.json({ data: [] })));
    renderApp('/t/taazaa/settings/review-statuses');
    expect(await screen.findByText("This tab isn't open to you")).toBeInTheDocument();
  });
});
