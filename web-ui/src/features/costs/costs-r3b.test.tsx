import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { line, OPERATOR, serveCosts, summary } from './testing';

const open = async () => {
  renderApp('/t/taazaa/costs');
  return screen.findByRole('heading', { name: 'Costs', level: 1 });
};

const tileOf = async (label: string) => within(await screen.findByRole('list', { name: 'Cost totals' })).getByText(label).closest('li')!;

describe('Cost per win tiles (R3b)', () => {
  it('shows cost per account sent, cost per won account with its target, and return on spend', async () => {
    serveCosts();
    await open();
    expect(await tileOf('Cost per account sent')).toHaveTextContent('$75');
    const won = await tileOf('Cost per won account');
    expect(won).toHaveTextContent('$1,500');
    expect(won).toHaveTextContent('Target $2,000');
    expect(await tileOf('Return on spend')).toHaveTextContent('3.2x');
  });

  it('says so with no target, no wins and no spend', async () => {
    serveCosts({ summary: summary({ target_cost_per_won_cents: null, cost_per_won_cents: null, cost_per_sent_cents: null, return_ratio: null }) });
    await open();
    expect(await tileOf('Cost per won account')).toHaveTextContent('No target set');
    expect(await tileOf('Return on spend')).toHaveTextContent('No spend yet');
  });

  it('Set target saves the amount in cents and toasts', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Set target' }));
    const input = screen.getByLabelText('Target cost per won account');
    await userEvent.clear(input);
    await userEvent.type(input, '1,800.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save target' }));
    expect(await screen.findByText('Target saved.')).toBeInTheDocument();
    expect(seen.find((s) => s.method === 'PUT')).toMatchObject({ body: { target_cost_per_won_cents: 180_050 } });
  });

  it('clearing the target sends null and toasts', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Set target' }));
    await userEvent.clear(screen.getByLabelText('Target cost per won account'));
    await userEvent.click(screen.getByRole('button', { name: 'Save target' }));
    expect(await screen.findByText('Target cleared.')).toBeInTheDocument();
    expect(seen.find((s) => s.method === 'PUT')).toMatchObject({ body: { target_cost_per_won_cents: null } });
  });

  it('refuses a target of zero without asking the API', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Set target' }));
    const input = screen.getByLabelText('Target cost per won account');
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save target' }));
    expect(await screen.findByText('Enter a target above zero, or clear it.')).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('shows Set target only with budgets:write', async () => {
    serveCosts({ scopes: OPERATOR });
    await open();
    await tileOf('Cost per won account');
    expect(screen.queryByRole('button', { name: 'Set target' })).toBeNull();
  });
});

describe('Cost by source (R3b)', () => {
  it('lists sources with the Shared costs row last and unlinked', async () => {
    serveCosts();
    await open();
    const card = await screen.findByRole('region', { name: 'Cost by source' });
    const heads = (await within(card).findAllByRole('columnheader')).map((h) => h.textContent);
    expect(heads).toEqual(['Source', 'Spend', 'Share', 'Per account sent', 'Per assigned', 'Per won account', 'Return']);
    const rows = within(card).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('$2,000');
    expect(rows[0]).toHaveTextContent('67%');
    expect(rows[0]).toHaveTextContent('$50');
    expect(rows[0]).toHaveTextContent('$100');
    expect(rows[0]).toHaveTextContent('$1,000');
    expect(rows[0]).toHaveTextContent('4.5x');
    expect(within(rows[0]!).getByRole('link', { name: 'Agency' })).toHaveAttribute('href', '/t/taazaa/funnel/src_agency');
    expect(rows[1]).toHaveTextContent('Riley');
    expect(rows[2]).toHaveTextContent('Shared costs');
    expect(rows[2]).toHaveTextContent('$400');
    expect(within(rows[2]!).queryByRole('link')).toBeNull();
    expect(card).toHaveTextContent('Return is the value of won deals divided by spend. Won value is what each deal closed at.');
  });
});

describe('Cost line source (R3b)', () => {
  it('shows the source name on a line', async () => {
    serveCosts({ lines: [line({ id: 'l1', note: 'Booth', source_id: 'src_agency', source_name: 'Agency' })] });
    await open();
    const row = (await screen.findByText('Booth')).closest('tr')!;
    expect(row).toHaveTextContent('Agency');
  });

  it('Add cost has an optional Source picker and sends the choice', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Add cost' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add cost' });
    await within(dialog).findByRole('option', { name: 'Agency' });
    await userEvent.type(within(dialog).getByLabelText('Amount'), '500');
    await userEvent.selectOptions(within(dialog).getByLabelText('Source'), 'src_agency');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add cost' }));
    await screen.findByText('Cost added.');
    expect(seen[0]!.body).toMatchObject({ amount_cents: 50_000, source_id: 'src_agency' });
  });

  it('sends no source when none is chosen', async () => {
    const seen = serveCosts();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Add cost' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add cost' });
    await userEvent.type(within(dialog).getByLabelText('Amount'), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add cost' }));
    await screen.findByText('Cost added.');
    expect(seen[0]!.body).toMatchObject({ source_id: null });
  });
});
