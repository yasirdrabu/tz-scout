import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { http } from 'msw';
import { category, CATEGORIES, line, MANUAL, OPERATOR, READER, serveCosts, summary, USAGE, VOIDED } from './testing';

const open = async () => {
  renderApp('/t/taazaa/costs');
  return screen.findByRole('heading', { name: 'Costs', level: 1 });
};

describe('Costs summary', () => {
  it('shows the title and the three tiles', async () => {
    serveCosts();
    await open();
    expect(screen.getByText('What finding accounts costs and where the money goes. Last 90 days.')).toBeInTheDocument();
    const tiles = await screen.findByRole('list', { name: 'Cost totals' });
    const tile = (label: string) => within(tiles).getByText(label).closest('li')!;
    expect(tile('Spend this month')).toHaveTextContent('$850');
    expect(tile('Budget used')).toHaveTextContent('28%');
    expect(tile('Budget used')).toHaveTextContent('of $3,000 monthly total');
    expect(tile('Last 90 days')).toHaveTextContent('$3,000');
  });

  it('lists the five categories under Where the money goes with 90-day spend and share', async () => {
    serveCosts();
    await open();
    const card = await screen.findByRole('region', { name: 'Where the money goes' });
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent('Data vendors');
    expect(rows[1]).toHaveTextContent('$1,200');
    expect(rows[1]).toHaveTextContent('40%');
    expect(card).toHaveTextContent('$3,000 total');
  });

  it('draws six months; over 100% is red and 92% is amber', async () => {
    serveCosts();
    await open();
    const card = await screen.findByRole('region', { name: 'Monthly spend' });
    const bars = within(card).getAllByRole('listitem');
    expect(bars).toHaveLength(6);
    expect(bars[5]).toHaveTextContent('Nov');
    expect(bars[5]!.querySelector('.barOver')).not.toBeNull();
    expect(bars[4]!.querySelector('.barWarn')).not.toBeNull();
    expect(bars[4]!.querySelector('.barOver')).toBeNull();
    expect(bars[0]!.querySelector('.barOver, .barWarn')).toBeNull();
    expect(card).toHaveTextContent('Budget $1,000');
  });

  it('shows the API words and Try again when the summary fails', async () => {
    serveCosts();
    server.use(http.get('/api/v1/costs/summary', () => problem(500, 'The summary is down.')));
    await open();
    expect(await screen.findByText("Costs didn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Monthly budgets', () => {
  const tight = summary({
    categories: [
      category({ key: 'partner_fees', label: 'Partner fees', spend_month_cents: 10_000, budget_cents: 100_000 }),
      category({ key: 'data_vendors', label: 'Data vendors', spend_month_cents: 92_000, budget_cents: 100_000, level: 'alert', pausable: true }),
      category({ key: 'agents_hosting', label: 'Agents and hosting', spend_month_cents: 0, budget_cents: null }),
      category({ key: 'lists_events', label: 'Lists and events', spend_month_cents: 0, budget_cents: null }),
      category({ key: 'ai_usage', label: 'AI usage', spend_month_cents: 120_000, budget_cents: 100_000, level: 'paused', pausable: true }),
    ],
  });

  it('reads used, of the budget, and the n% used, Over by or left status', async () => {
    serveCosts({ summary: tight });
    await open();
    const card = await screen.findByRole('region', { name: 'Monthly budgets' });
    const row = (name: string) => within(card).getByText(name).closest('li')!;
    expect(row('Partner fees')).toHaveTextContent('$100 of $1,000');
    expect(row('Partner fees')).toHaveTextContent('$900 left');
    expect(row('Data vendors')).toHaveTextContent('$920 of $1,000');
    expect(row('Data vendors')).toHaveTextContent('92% used');
    expect(row('AI usage')).toHaveTextContent('Over by $200.00');
    expect(row('Lists and events')).toHaveTextContent('No budget');
    expect(row('Lists and events')).not.toHaveTextContent('of $0');
  });

  it('rounds the percent down, so 99.9% reads 99% used', async () => {
    const near = summary({ categories: [category({ key: 'ai_usage', label: 'AI usage', spend_month_cents: 99_900, budget_cents: 100_000, level: 'alert', pausable: true })] });
    serveCosts({ summary: near });
    await open();
    const card = await screen.findByRole('region', { name: 'Monthly budgets' });
    expect(within(card).getByText('AI usage').closest('li')).toHaveTextContent('99% used');
    expect(await screen.findByText('AI usage has used 99% of its November budget.')).toBeInTheDocument();
  });

  it('pre-fills a budget with cents and saves it back unchanged', async () => {
    const cents = summary({ categories: [category({ key: 'ai_usage', label: 'AI usage', spend_month_cents: 0, budget_cents: 1250, pausable: true })] });
    const seen = serveCosts({ summary: cents });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budgets' }));
    expect(screen.getByLabelText('AI usage budget')).toHaveValue('12.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
    await screen.findByText('Budgets saved. Monthly total $12.50.');
    expect(seen.find((s) => s.method === 'PUT')!.body).toEqual({ month: '2026-11', budgets: [{ category: 'ai_usage', amount_cents: 1250 }] });
  });

  it('refuses a budget that is not an amount', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budgets' }));
    const ai = screen.getByLabelText('AI usage budget');
    await userEvent.clear(ai);
    await userEvent.type(ai, '1e3');
    await userEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
    expect(await screen.findByText('AI usage: Enter a number.')).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('shows Edit budgets only with budgets:write', async () => {
    serveCosts({ scopes: OPERATOR });
    await open();
    await screen.findByRole('region', { name: 'Monthly budgets' });
    expect(screen.queryByRole('button', { name: 'Edit budgets' })).toBeNull();
  });

  it('saves every category and toasts the monthly total', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budgets' }));
    const ai = screen.getByLabelText('AI usage budget');
    await userEvent.clear(ai);
    await userEvent.type(ai, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
    expect(await screen.findByText('Budgets saved. Monthly total $2,510.')).toBeInTheDocument();
    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.body).toEqual({
      month: '2026-11',
      budgets: [
        { category: 'partner_fees', amount_cents: 100_000 },
        { category: 'data_vendors', amount_cents: 100_000 },
        { category: 'agents_hosting', amount_cents: 50_000 },
        { category: 'lists_events', amount_cents: 0 },
        { category: 'ai_usage', amount_cents: 1_000 },
      ],
    });
    expect(screen.queryByRole('button', { name: 'Save budgets' })).toBeNull();
  });

  it('Cancel drops the edits', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budgets' }));
    await userEvent.type(screen.getByLabelText('AI usage budget'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit budgets' })).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('shows the API words when the save fails', async () => {
    serveCosts({ answer: { 'PUT budgets': () => problem(409, "Past months can't be changed.") } });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit budgets' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
    expect(await screen.findByText("Past months can't be changed.")).toBeInTheDocument();
  });
});

describe('Budget banners', () => {
  const alerts = summary({
    categories: [
      ...CATEGORIES.slice(0, 1),
      category({ key: 'data_vendors', label: 'Data vendors', spend_month_cents: 92_000, budget_cents: 100_000, level: 'alert', pausable: true }),
      category({ key: 'ai_usage', label: 'AI usage', spend_month_cents: 120_000, budget_cents: 100_000, level: 'paused', pausable: true }),
    ],
  });

  it('shows the alert and the pause on Costs', async () => {
    serveCosts({ summary: alerts });
    await open();
    expect(await screen.findByText('Data vendors has used 92% of its November budget.')).toBeInTheDocument();
    expect(screen.getByText('AI usage is paused: it is over 110% of its November budget. Raise the budget to resume.')).toBeInTheDocument();
  });

  it('puts the live region on the list', async () => {
    serveCosts({ summary: alerts });
    await open();
    expect(await screen.findByRole('alert', { name: 'Budget alerts' })).toBeInstanceOf(HTMLUListElement);
  });

  it('shows nothing when every category is ok', async () => {
    serveCosts();
    await open();
    await screen.findByRole('region', { name: 'Monthly budgets' });
    expect(screen.queryByRole('list', { name: 'Budget alerts' })).toBeNull();
  });
});

describe('Cost lines', () => {
  it('lists lines, with Edit only on manual lines and Void on every open line', async () => {
    serveCosts();
    await open();
    const card = await screen.findByRole('region', { name: 'Cost lines' });
    const manual = (await within(card).findByText('Referral fee')).closest('tr')!;
    expect(manual).toHaveTextContent('Partner fees');
    expect(manual).toHaveTextContent('$125');
    expect(within(manual).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(manual).getByRole('button', { name: 'Void' })).toBeInTheDocument();
    const usage = within(card).getByText('Anthropic').closest('tr')!;
    expect(usage).toHaveTextContent('$3.40');
    expect(within(usage).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(usage).getByRole('button', { name: 'Void' })).toBeInTheDocument();
    expect(within(card).queryByText('Wrong month')).toBeNull();
  });

  it('Show voided lists voided lines with the reason', async () => {
    serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show voided' }));
    const row = (await screen.findByText('Wrong month')).closest('tr')!;
    expect(row).toHaveTextContent('Voided: Duplicate');
    expect(within(row).queryByRole('button', { name: 'Void' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('hides the write buttons without costs:write', async () => {
    serveCosts({ scopes: READER });
    await open();
    await screen.findByText('Referral fee');
    expect(screen.queryByRole('button', { name: 'Add cost' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('says so when there are no lines', async () => {
    serveCosts({ lines: [] });
    await open();
    expect(await screen.findByText('No costs yet')).toBeInTheDocument();
  });

  it('Add cost refuses an amount of 0 and sends the line when it is above zero', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Add cost' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add cost' });
    await userEvent.type(within(dialog).getByLabelText('Amount'), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add cost' }));
    expect(await within(dialog).findByText('Enter an amount above zero.')).toBeInTheDocument();
    expect(seen).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText('Amount'));
    await userEvent.type(within(dialog).getByLabelText('Amount'), '12.50');
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'ai_usage');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Offsite');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add cost' }));
    await screen.findByText('Cost added.');
    expect(seen[0]!.body).toMatchObject({ category: 'ai_usage', amount_cents: 1250, note: 'Offsite' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toHaveProperty('occurred_on', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('Edit opens the line and sends the changes', async () => {
    const seen = serveCosts({ lines: [MANUAL, USAGE] });
    await open();
    const row = (await screen.findByText('Referral fee')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit cost' });
    const amount = within(dialog).getByLabelText('Amount');
    expect(amount).toHaveValue('125.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '90');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save cost' }));
    await screen.findByText('Cost saved.');
    expect(seen[0]).toMatchObject({ method: 'PATCH', body: { amount_cents: 9000, category: 'partner_fees', occurred_on: '2026-11-03' } });
  });

  it('Void asks for a reason, then sends it', async () => {
    const seen = serveCosts({ lines: [MANUAL, USAGE, VOIDED, line({ id: 'x', note: 'x' })] });
    await open();
    const row = (await screen.findByText('Referral fee')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('dialog', { name: 'Void this cost?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void cost' }));
    expect(await within(dialog).findByText("Say why you're voiding this cost.")).toBeInTheDocument();
    expect(seen).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Duplicate');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void cost' }));
    await screen.findByText('Cost voided.');
    expect(seen[0]).toMatchObject({ method: 'POST', body: { reason: 'Duplicate' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
