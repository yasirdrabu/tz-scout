import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { Rule, SavedWarmIntros, WarmIntrosEdit, WarmIntrosView } from './api';

const RELATIONSHIPS = [
  { key: 'customer', label: 'Referred by a current customer', points: 12, intro_count: 4 },
  { key: 'partner', label: 'Referred by a partner', points: 10, intro_count: 2 },
  { key: 'board', label: 'Board member or investor intro', points: 10, intro_count: 0 },
  { key: 'team', label: 'Someone on our team knows them', points: 8, intro_count: 5 },
  { key: 'event', label: 'Met in person at an event', points: 4, intro_count: 1 },
  { key: 'other', label: 'Other', points: 2, intro_count: 0 },
];

const RULE: Rule = {
  id: 'wir_1',
  introducer_user_id: 'usr_ash',
  introducer_email: 'ash@taazaa.com',
  introducer_name: 'Ash Patel',
  relationship_key: 'team',
  points: 15,
  intro_count: 2,
};

const VIEW: WarmIntrosView = {
  relationships: RELATIONSHIPS,
  rules: [RULE],
  introducers: [
    { user_id: 'usr_ash', email: 'ash@taazaa.com', name: 'Ash Patel', intro_count: 2 },
    { user_id: 'usr_bo', email: 'bo@taazaa.com', name: 'Bo Chen', intro_count: 0 },
    { user_id: null, email: 'pat@partner.com', name: 'Pat Outside', intro_count: 1 },
  ],
};

let puts: WarmIntrosEdit[] = [];

function serve(opts: { scopes?: string[]; view?: WarmIntrosView; count?: number; put?: () => Response | undefined } = {}) {
  puts = [];
  serveMe({ taazaa: { scopes: opts.scopes ?? ['scoring:manage'] } });
  server.use(
    http.get('/api/v1/settings/warm-intros', () => HttpResponse.json(opts.view ?? VIEW)),
    http.put('/api/v1/settings/warm-intros', async ({ request }) => {
      const body = (await request.json()) as WarmIntrosEdit;
      puts.push(body);
      const answer = opts.put?.();
      if (answer) return answer;
      const saved: SavedWarmIntros = {
        ...VIEW,
        relationships: RELATIONSHIPS.map((r) => ({ ...r, points: body.relationships.find((b) => b.key === r.key)!.points })),
        rules: body.rules.map((r, i) => ({
          id: r.id ?? `wir_new${i}`,
          introducer_user_id: r.introducer_user_id ?? null,
          introducer_email: r.introducer_email ?? null,
          introducer_name: r.introducer_name ?? null,
          relationship_key: r.relationship_key,
          points: r.points,
          intro_count: 0,
        })),
        rescoring_account_count: opts.count ?? 3,
      };
      return HttpResponse.json(saved);
    }),
  );
}

const open = async () => {
  renderApp('/t/taazaa/settings/warm-intros');
  await screen.findByRole('table', { name: 'Relationships' });
};

describe('Settings > Warm intros', () => {
  it('shows the intro, both tables with their columns, the loaded values and the footnote', async () => {
    serve();
    await open();
    expect(
      screen.getByText(
        "Warm intros add points to an account's priority, from 0 to 20. An intro gets its relationship's points unless the introducer has a rule of their own. An intro an agent or vendor declared counts half until someone confirms it. Only the strongest intro on an account counts.",
      ),
    ).toBeInTheDocument();
    const rel = screen.getByRole('table', { name: 'Relationships' });
    for (const h of ['Relationship', 'Points', 'Intros']) expect(within(rel).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(rel).getAllByRole('row')).toHaveLength(7);
    expect(within(rel).getByText('Referred by a current customer')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Points for Referred by a current customer' })).toHaveValue(12);
    expect(screen.getByText("Give one person's intros more or fewer points than their relationship.")).toBeInTheDocument();
    const rules = screen.getByRole('table', { name: 'Introducer rules' });
    for (const h of ['Introducer', 'Relationship', 'Points', 'Intros']) expect(within(rules).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(rules).getByText('Ash Patel · ash@taazaa.com')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Points for Ash Patel, Someone on our team knows them' })).toHaveValue(15);
    expect(screen.getByRole('button', { name: 'Remove rule for Ash Patel' })).toBeInTheDocument();
    expect(screen.getByText('Saving rescores only the accounts whose intros change. Tiers someone set by hand stay as they are.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save warm intros' })).toBeDisabled();
  });

  it('shows the empty state when there are no rules', async () => {
    serve({ view: { ...VIEW, rules: [] } });
    await open();
    expect(screen.getByText("No introducer rules yet. Every intro gets its relationship's points.")).toBeInTheDocument();
  });

  it('is not a tab without scoring:manage', async () => {
    serve({ scopes: ['members:read'] });
    renderApp('/t/taazaa/settings/warm-intros');
    expect(await screen.findByText("This tab isn't open to you")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Warm intros' })).toBeNull();
  });

  it('editing points enables Discard and Save; Discard restores the loaded values', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    const input = screen.getByRole('spinbutton', { name: 'Points for Other' });
    await user.clear(input);
    await user.type(input, '7');
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save warm intros' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('spinbutton', { name: 'Points for Other' })).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'Save warm intros' })).toBeDisabled();
  });

  it('points outside 0 to 20 show the error and block saving', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    const input = screen.getByRole('spinbutton', { name: 'Points for Other' });
    await user.clear(input);
    await user.type(input, '21');
    expect(await screen.findByText('Points must be a whole number from 0 to 20.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save warm intros' })).toBeDisabled();
    await user.clear(screen.getByRole('spinbutton', { name: 'Points for Ash Patel, Someone on our team knows them' }));
    expect(screen.getAllByText('Points must be a whole number from 0 to 20.')).toHaveLength(2);
    expect(puts).toHaveLength(0);
  });

  it('adds a rule for a member, saves the whole body and toasts the rescoring count', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    const pick = screen.getByRole('combobox', { name: 'Introducer for the new rule' });
    expect(within(pick).getByRole('option', { name: 'Pick a person' })).toBeInTheDocument();
    expect(within(pick).getByRole('option', { name: 'Bo Chen · bo@taazaa.com' })).toBeInTheDocument();
    expect(within(pick).getByRole('option', { name: 'Pat Outside · pat@partner.com' })).toBeInTheDocument();
    expect(within(pick).getByRole('option', { name: 'Someone else' })).toBeInTheDocument();
    await user.selectOptions(pick, 'Bo Chen · bo@taazaa.com');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Relationship for Bo Chen' }), 'Referred by a partner');
    await user.type(screen.getByRole('spinbutton', { name: 'Points for Bo Chen, Referred by a partner' }), '18');
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    expect(await screen.findByText('Warm intros saved. Rescoring 3 accounts.')).toBeInTheDocument();
    expect(puts[0]!.relationships).toHaveLength(6);
    expect(puts[0]!.relationships[0]).toEqual({ key: 'customer', points: 12 });
    expect(puts[0]!.rules).toEqual([
      { id: 'wir_1', introducer_user_id: 'usr_ash', relationship_key: 'team', points: 15 },
      { introducer_user_id: 'usr_bo', relationship_key: 'partner', points: 18 },
    ]);
    expect(screen.getByRole('button', { name: 'Save warm intros' })).toBeDisabled();
  });

  it('a known outside introducer sends email and name', async () => {
    serve();
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Introducer for the new rule' }), 'Pat Outside · pat@partner.com');
    await user.type(screen.getByRole('spinbutton', { name: /^Points for Pat Outside/ }), '5');
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.rules[1]).toEqual({ introducer_email: 'pat@partner.com', introducer_name: 'Pat Outside', relationship_key: 'customer', points: 5 });
  });

  it('Someone else needs a name and email, then sends them', async () => {
    serve({ count: 1 });
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Introducer for the new rule' }), 'Someone else');
    await user.type(screen.getByRole('spinbutton', { name: /^Points for the new rule/ }), '3');
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    expect(await screen.findByText("Enter the person's name and email.")).toBeInTheDocument();
    expect(puts).toHaveLength(0);
    await user.type(screen.getByRole('textbox', { name: 'Name of the new introducer' }), 'Cleo Fox');
    await user.type(screen.getByRole('textbox', { name: 'Email of the new introducer' }), 'cleo@fox.io');
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    expect(await screen.findByText('Warm intros saved. Rescoring 1 account.')).toBeInTheDocument();
    expect(puts[0]!.rules[1]).toEqual({ introducer_email: 'cleo@fox.io', introducer_name: 'Cleo Fox', relationship_key: 'customer', points: 3 });
  });

  it('removes a rule and saves without it; says only "saved" when nothing is rescored', async () => {
    serve({ count: 0 });
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove rule for Ash Patel' }));
    expect(screen.getByText("No introducer rules yet. Every intro gets its relationship's points.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    expect(await screen.findByText('Warm intros saved.')).toBeInTheDocument();
    expect(puts[0]!.rules).toEqual([]);
  });

  it('shows the API message for a duplicate rule at the row and keeps the draft', async () => {
    serve({
      put: () =>
        HttpResponse.json(
          {
            type: 'https://scout.taazaa.ai/problems/validation',
            title: 'Ash Patel already has a rule for someone on our team knows them.',
            status: 400,
            correlation_id: 'cor_1',
            errors: [{ path: 'rules[0].relationship_key', message: 'Ash Patel already has a rule for someone on our team knows them.' }],
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await open();
    const user = userEvent.setup();
    const input = screen.getByRole('spinbutton', { name: 'Points for Ash Patel, Someone on our team knows them' });
    await user.clear(input);
    await user.type(input, '9');
    await user.click(screen.getByRole('button', { name: 'Save warm intros' }));
    const row = screen.getByRole('button', { name: 'Remove rule for Ash Patel' }).closest('tr')!;
    expect(await within(row).findByText('Ash Patel already has a rule for someone on our team knows them.')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Points for Ash Patel, Someone on our team knows them' })).toHaveValue(9);
    expect(screen.queryByText(/Warm intros saved/)).toBeNull();
  });

  it('says so when the settings do not load', async () => {
    serve();
    server.use(http.get('/api/v1/settings/warm-intros', () => problem(500, 'Boom')));
    renderApp('/t/taazaa/settings/warm-intros');
    expect(await screen.findByText("Warm intros didn't load")).toBeInTheDocument();
  });
});
