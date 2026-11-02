import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { Stage, StageEdit, StagesView, Trigger } from './api';

const TRIGGERS: Trigger[] = [
  { key: 'source_creates', label: 'A source or import creates it', limit: 'first' },
  { key: 'reviewer_sets_tier', label: 'A reviewer sets a tier', limit: 'one' },
  { key: 'ae_accepts', label: 'An AE accepts the assignment', limit: 'one' },
  { key: 'reply_or_meeting', label: 'A reply or meeting is logged', limit: 'one' },
  { key: 'meeting_booked', label: 'A meeting is booked', limit: 'one' },
  { key: 'deal_created', label: 'A HubSpot deal is created', limit: 'one' },
  { key: 'deal_reaches_stage', label: 'HubSpot deal reaches this stage', limit: 'many' },
  { key: 'deal_closed_won', label: 'HubSpot deal is Closed won', limit: 'won' },
  { key: 'deal_closed_lost', label: 'HubSpot deal is Closed lost', limit: 'one' },
  { key: 'reviewer_rejects', label: 'A reviewer rejects it', limit: 'one' },
  { key: 'playbook_no_reply', label: 'Playbook ends with no reply', limit: 'one' },
  { key: 'by_hand', label: 'Set by hand', limit: 'many' },
];

const stage = (s: Partial<Stage> & Pick<Stage, 'key' | 'name' | 'trigger' | 'position'>): Stage => ({
  description: null,
  kind: 'flow',
  trigger_label: TRIGGERS.find((t) => t.key === s.trigger)!.label,
  hubspot_stage: null,
  quarter_target: null,
  locked: null,
  ...s,
});

const DEFAULTS: Stage[] = [
  stage({ key: 'arrived', name: 'Sent', trigger: 'source_creates', position: 0, locked: 'first' }),
  stage({ key: 'reviewed', name: 'Reviewed', trigger: 'reviewer_sets_tier', position: 1 }),
  stage({ key: 'assigned', name: 'Assigned', trigger: 'ae_accepts', position: 2 }),
  stage({ key: 'engaged', name: 'Engaged', trigger: 'reply_or_meeting', position: 3 }),
  stage({ key: 'opportunity', name: 'Opportunity', trigger: 'deal_created', position: 4 }),
  stage({ key: 'won', name: 'Won', trigger: 'deal_closed_won', position: 5, hubspot_stage: 'closedwon', locked: 'won' }),
  stage({ key: 'declined', name: 'Disqualified', trigger: 'reviewer_rejects', position: 0, kind: 'exit' }),
  stage({ key: 'back_to_nurture', name: 'Back to nurture', trigger: 'playbook_no_reply', position: 1, kind: 'exit' }),
  stage({ key: 'lost', name: 'Lost', trigger: 'deal_closed_lost', position: 2, kind: 'exit', hubspot_stage: 'closedlost' }),
];

// The workspace has renamed Engaged and set targets, so Restore defaults has something to undo.
const SAVED: Stage[] = DEFAULTS.map((s) => (s.key === 'engaged' ? { ...s, name: 'Talking', quarter_target: 320 } : s));

const view = (stages: Stage[]): StagesView => ({ stages, defaults: DEFAULTS, triggers: TRIGGERS });

let puts: { stages: StageEdit[] }[] = [];

function serve(opts: { scopes?: string[]; put?: (body: { stages: StageEdit[] }) => Response | undefined } = {}) {
  puts = [];
  serveMe({ taazaa: { scopes: opts.scopes ?? ['settings:manage'] } });
  server.use(
    http.get('/api/v1/stages', () => HttpResponse.json(view(SAVED))),
    http.get('/api/v1/settings/stages', () => HttpResponse.json(view(SAVED))),
    http.put('/api/v1/settings/stages', async ({ request }) => {
      const body = (await request.json()) as { stages: StageEdit[] };
      puts.push(body);
      const answer = opts.put?.(body);
      if (answer) return answer;
      const saved = body.stages.map((s, i) =>
        stage({ ...s, key: s.key ?? `stg_${i}`, position: i, locked: DEFAULTS.find((d) => d.key === s.key)?.locked ?? null } as Stage),
      );
      return HttpResponse.json(view(saved));
    }),
  );
}

const open = async () => {
  renderApp('/t/taazaa/settings/pipeline-stages');
  await screen.findByRole('table', { name: 'Stages' });
};
const row = (name: string) => screen.getByRole('textbox', { name: `Name of ${name}` }).closest('tr')!;

describe('Settings > Pipeline stages', () => {
  it('shows the intro, the two tables with their columns, and the footer', async () => {
    serve();
    await open();
    expect(screen.getByText(/The stages every account moves through, in order\./)).toBeInTheDocument();
    expect(screen.getByText(/Renaming keeps history; deleting moves accounts back one stage\./)).toBeInTheDocument();
    const stages = screen.getByRole('table', { name: 'Stages' });
    for (const h of ['Name', 'What it means', 'Moves here when', 'HubSpot stage', 'Quarter target']) {
      expect(within(stages).getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(within(stages).getAllByRole('row')).toHaveLength(7);
    expect(within(screen.getByRole('table', { name: 'Exits' })).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText(/The first stage and the won stage can be renamed but not deleted\./)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name of Talking' })).toHaveValue('Talking');
    expect(screen.getByRole('spinbutton', { name: 'Quarter target for Talking' })).toHaveValue(320);
  });

  it('offers the API triggers, disables one-per-trigger options another row has, and shows locked triggers read-only', async () => {
    serve();
    await open();
    const select = within(row('Opportunity')).getByRole('combobox', { name: 'Moves here when for Opportunity' });
    expect(within(select).getAllByRole('option')).toHaveLength(TRIGGERS.length);
    expect(within(select).getByRole('option', { name: 'A reviewer sets a tier' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'A source or import creates it' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'HubSpot deal is Closed won' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'A HubSpot deal is created' })).toBeEnabled();
    expect(within(select).getByRole('option', { name: 'Set by hand' })).toBeEnabled();
    expect(within(row('Sent')).queryByRole('combobox')).toBeNull();
    expect(within(row('Sent')).getByText('A source or import creates it')).toBeInTheDocument();
    expect(within(row('Won')).getByText('HubSpot deal is Closed won')).toBeInTheDocument();
  });

  it('needs a HubSpot stage when the stage moves on one, and sends it', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    await user.selectOptions(within(row('Opportunity')).getByRole('combobox', { name: /Moves here when/ }), 'HubSpot deal reaches this stage');
    const hubspot = within(row('Opportunity')).getByRole('textbox', { name: 'HubSpot stage for Opportunity' });
    expect(hubspot).toBeRequired();
    await user.type(hubspot, 'qualifiedtobuy');
    await user.click(screen.getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.stages.find((s) => s.key === 'opportunity')).toMatchObject({ trigger: 'deal_reaches_stage', hubspot_stage: 'qualifiedtobuy' });
  });

  it('Add stage puts a new stage before Won; Save sends it without a key and toasts', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Save stages' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Add stage' }));
    const stages = screen.getByRole('table', { name: 'Stages' });
    const names = within(stages).getAllByRole('textbox', { name: /^Name of / });
    expect(names).toHaveLength(6 + 1);
    const added = names[5]!;
    expect(within(added.closest('tr')!).getByRole('combobox')).toHaveValue('by_hand');
    await user.type(added, '  Proposal ');
    await user.click(screen.getByRole('button', { name: 'Save stages' }));
    expect(await screen.findByText('Pipeline stages saved. The pipeline and scorecard use them now.')).toBeInTheDocument();
    const sent = puts[0]!.stages;
    expect(sent).toHaveLength(10);
    expect(sent[5]).toEqual({ name: 'Proposal', description: null, kind: 'flow', trigger: 'by_hand', hubspot_stage: null, quarter_target: null });
    expect(sent[6]).toMatchObject({ key: 'won' });
    expect(sent[0]).toMatchObject({ key: 'arrived', name: 'Sent' });
    expect(sent[3]).toMatchObject({ key: 'engaged', name: 'Talking', quarter_target: 320 });
    expect(screen.getByRole('button', { name: 'Save stages' })).toBeDisabled();
  });

  it('Add exit appends an exit with no quarter target', async () => {
    serve();
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add exit' }));
    const exits = screen.getByRole('table', { name: 'Exits' });
    const added = within(exits).getAllByRole('textbox', { name: /^Name of / }).at(-1)!;
    expect(within(added.closest('tr')!).getByRole('spinbutton')).toBeDisabled();
  });

  it('moves a stage up and down, blocked at the first and won stages', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Move Sent up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Sent down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Reviewed up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Opportunity down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Reviewed down' }));
    const stages = within(screen.getByRole('table', { name: 'Stages' }));
    expect(stages.getAllByRole('textbox', { name: /^Name of / }).map((i) => (i as HTMLInputElement).value)).toEqual(['Sent', 'Assigned', 'Reviewed', 'Talking', 'Opportunity', 'Won']);
    await user.click(screen.getByRole('button', { name: 'Move Back to nurture up' }));
    await user.click(screen.getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.stages.map((s) => s.key)).toEqual(['arrived', 'assigned', 'reviewed', 'engaged', 'opportunity', 'won', 'back_to_nurture', 'declined', 'lost']);
  });

  it('Delete removes a row from the draft; the first and won stage say they stay', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete Sent' }));
    expect(await screen.findByText('The first stage can be renamed but not deleted.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Won' }));
    expect(await screen.findByText('The won stage can be renamed but not deleted.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name of Won' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Opportunity' }));
    expect(screen.queryByRole('textbox', { name: 'Name of Opportunity' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save stages' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.stages.map((s) => s.key)).not.toContain('opportunity');
  });

  it('Discard drops the draft; Restore defaults fills it from the defaults without saving', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Name of Talking' }), '!');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('textbox', { name: 'Name of Talking' })).toHaveValue('Talking');
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(screen.getByRole('textbox', { name: 'Name of Engaged' })).toHaveValue('Engaged');
    expect(screen.getByRole('spinbutton', { name: 'Quarter target for Engaged' })).toHaveValue(null);
    expect(puts).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save stages' })).toBeEnabled();
  });

  it('shows the API errors next to the field and keeps the draft', async () => {
    serve({
      put: () =>
        HttpResponse.json(
          {
            type: 'https://scout.taazaa.ai/problems/validation',
            title: 'Some stages need fixing.',
            status: 400,
            correlation_id: 'cor_1',
            errors: [
              { path: 'stages.1.name', message: 'Every stage needs a name.' },
              { path: 'stages.4.hubspot_stage', message: 'A stage that moves on a HubSpot deal stage needs that HubSpot stage.' },
              { path: 'stages', message: 'The first stage and the won stage can be renamed but not deleted.' },
            ],
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await open();
    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox', { name: 'Name of Reviewed' }));
    await user.click(screen.getByRole('button', { name: 'Save stages' }));
    expect(await within(row('Reviewed')).findByText('Every stage needs a name.')).toBeInTheDocument();
    expect(within(row('Opportunity')).getByText('A stage that moves on a HubSpot deal stage needs that HubSpot stage.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The first stage and the won stage can be renamed but not deleted.');
    expect(screen.getByRole('textbox', { name: 'Name of Reviewed' })).toHaveValue('');
    expect(screen.queryByText(/Pipeline stages saved/)).toBeNull();
  });

  it('says so when the stages do not load', async () => {
    serve();
    server.use(http.get('/api/v1/settings/stages', () => problem(500, 'Boom')), http.get('/api/v1/stages', () => problem(500, 'Boom')));
    renderApp('/t/taazaa/settings/pipeline-stages');
    expect(await screen.findByText("Pipeline stages didn't load")).toBeInTheDocument();
  });

  it('is not a tab without settings:manage', async () => {
    serve({ scopes: ['members:read'] });
    renderApp('/t/taazaa/settings/pipeline-stages');
    expect(await screen.findByText("This tab isn't open to you")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pipeline stages' })).toBeNull();
  });
});
