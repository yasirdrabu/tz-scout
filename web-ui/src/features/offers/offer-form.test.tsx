import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { offer, serveOffers } from './testing';

const drawer = (name: string) => screen.findByRole('dialog', { name });
const bodies = (seen: ReturnType<typeof serveOffers>, method: string, end: string) =>
  seen.filter((r) => r.method === method && r.url.pathname.endsWith(end)).map((r) => r.body as Record<string, unknown>);

describe('Offer form (§19)', () => {
  it('edits content: PATCH with the fields, no status call, the toast, and the drawer closes', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.click(await screen.findByRole('button', { name: 'Edit offer' }));
    const d = await drawer('Edit offer');
    expect(within(d).getByLabelText('Title')).toHaveValue('Modernization Blueprint');
    expect(within(d).getByRole('radio', { name: /Active/ })).toBeChecked();
    expect(within(d).getByText('Scout matches accounts to it')).toBeInTheDocument();
    expect(within(d).getByText('Hidden from matching')).toBeInTheDocument();
    expect(within(d).getByLabelText('Amount')).toHaveValue(85000);
    await user.type(within(d).getByLabelText('Why us'), 'We did it before.');
    await user.selectOptions(within(d).getByLabelText('Pricing'), 'per_month');
    await user.clear(within(d).getByLabelText('Length (weeks)'));
    await user.type(within(d).getByLabelText('Length (weeks)'), '12');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes to Modernization Blueprint saved.')).toBeInTheDocument();
    const [body] = bodies(seen, 'PATCH', '/offers/off_mb');
    expect(body).toMatchObject({ why_us: 'We did it before.', price_model: 'per_month', price_min_cents: 8_500_000, price_max_cents: 8_500_000, length_weeks: 12, promise: 'A funded plan in six weeks.' });
    expect(seen.some((r) => /:(approve|unapprove)$/.test(r.url.pathname))).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit offer' })).toBeNull());
    expect(app.path()).toBe('/t/taazaa/offers/prc_ai/off_mb');
  });

  it('a save that does not touch the price leaves the price fields out, so a range stays', async () => {
    const seen = serveOffers({ offers: [offer({ id: 'off_r', name: 'Ranged', practice_id: 'prc_ai', price_min_cents: 2_500_000, price_max_cents: 4_500_050, price_label: '$25,000 to $45,000.50' })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_r?edit=offer');
    const d = await drawer('Edit offer');
    expect(await within(d).findByLabelText('Amount')).toHaveValue(25000);
    expect(within(d).getByLabelText('Up to')).toHaveValue(45000.5);
    await user.type(within(d).getByLabelText('Why us'), 'Because.');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Ranged saved.');
    const [body] = bodies(seen, 'PATCH', '/offers/off_r');
    expect(body).toMatchObject({ why_us: 'Because.' });
    for (const k of ['price_model', 'price_min_cents', 'price_max_cents']) expect(body).not.toHaveProperty(k);
  });

  it('editing Amount sends the cents, and the top of a range stays', async () => {
    const seen = serveOffers({ offers: [offer({ id: 'off_r', name: 'Ranged', practice_id: 'prc_ai', price_min_cents: 2_500_000, price_max_cents: 4_500_000 })] });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_r?edit=offer');
    const d = await drawer('Edit offer');
    await user.clear(await within(d).findByLabelText('Amount'));
    await user.type(within(d).getByLabelText('Amount'), '30000.25');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Ranged saved.');
    expect(bodies(seen, 'PATCH', '/offers/off_r')[0]).toMatchObject({ price_model: null, price_min_cents: 3_000_025, price_max_cents: 4_500_000 });
  });

  it('Custom quote sends no amount', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await drawer('Edit offer');
    await user.selectOptions(await within(d).findByLabelText('Pricing'), 'custom');
    expect(within(d).queryByLabelText('Amount')).toBeNull();
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Changes to Modernization Blueprint saved.');
    expect(bodies(seen, 'PATCH', '/offers/off_mb')[0]).toMatchObject({ price_model: 'custom', price_min_cents: null, price_max_cents: null });
  });

  it('a buyer edit shows the back-to-draft warning and keeps the form open; then Active approves', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await drawer('Edit offer');
    await user.type(await within(d).findByLabelText('Industries'), 'retail{Enter}');
    expect(within(d).getByRole('button', { name: 'Remove retail' })).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await within(d).findByText("This offer is back in Draft. Make it active again when you're ready.")).toBeInTheDocument();
    expect(bodies(seen, 'PATCH', '/offers/off_mb')[0]!.industries).toEqual(['logistics', 'retail']);
    expect(within(d).getByRole('radio', { name: /Draft/ })).toBeChecked();
    expect(seen.some((r) => r.url.pathname.endsWith(':approve'))).toBe(false);
    await user.click(within(d).getByRole('radio', { name: /Active/ }));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Modernization Blueprint is active.')).toBeInTheDocument();
    expect(seen.filter((r) => r.url.pathname.endsWith('off_mb:approve'))).toHaveLength(1);
  });

  it('making a draft active that the API refuses lists what is missing and keeps it as Draft', async () => {
    const seen = serveOffers({
      answer: {
        'off_sprint:approve': () =>
          HttpResponse.json(
            {
              type: 'https://scout.taazaa.ai/problems/offer-incomplete',
              title: 'This offer is not ready to approve.',
              status: 400,
              errors: [
                { path: 'offer', message: 'Add a typical deal size before approving.' },
                { path: 'offer', message: 'Add the sales cycle in days before approving.' },
              ],
            },
            { status: 400, headers: { 'content-type': 'application/problem+json' } },
          ),
      },
    });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_sprint?edit=offer');
    const d = await drawer('Edit offer');
    await user.click(await within(d).findByRole('radio', { name: /Active/ }));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(d).findByText('To make this offer active, add: Add a typical deal size before approving. Add the sales cycle in days before approving.'),
    ).toBeInTheDocument();
    expect(within(d).getByRole('radio', { name: /Draft/ })).toBeChecked();
    expect(bodies(seen, 'PATCH', '/offers/off_sprint')).toHaveLength(1);
  });

  it('Draft on an active offer unapproves it', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await drawer('Edit offer');
    await user.click(await within(d).findByRole('radio', { name: /Draft/ }));
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Modernization Blueprint is back in Draft.')).toBeInTheDocument();
    expect(seen.some((r) => r.url.pathname.endsWith('off_mb:unapprove'))).toBe(true);
  });

  it('Duplicate opens a new Draft prefilled as "{title} (copy)" and adds it to the practice', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    const d = await drawer('Add an offer');
    expect(await within(d).findByLabelText('Title')).toHaveValue('Modernization Blueprint (copy)');
    expect(within(d).getByRole('radio', { name: /Draft/ })).toBeChecked();
    expect(within(d).getByLabelText('Summary')).toHaveValue('A funded plan in six weeks.');
    await user.click(within(d).getByRole('button', { name: 'Add offer' }));
    expect(await screen.findByText('Modernization Blueprint (copy) added to AI Transformation.')).toBeInTheDocument();
    expect(bodies(seen, 'POST', '/api/v1/offers')[0]).toMatchObject({ name: 'Modernization Blueprint (copy)', practice_id: 'prc_ai', price_min_cents: 8_500_000 });
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/offers/prc_ai/off_new'));
  });

  it('a new offer needs a title; Add offer from the tree starts in that practice', async () => {
    serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai');
    await user.click(await screen.findByRole('button', { name: 'Add offer to Data Readiness' }));
    const d = await drawer('Add an offer');
    expect(within(d).getByLabelText('Practice')).toHaveValue('prc_data');
    await user.click(within(d).getByRole('button', { name: 'Add offer' }));
    expect(within(d).getByText('Give the offer a title.')).toBeInTheDocument();
  });

  it('a retired offer opens read only', async () => {
    serveOffers({ offers: [{ ...(await import('./testing')).BLUEPRINT, status: 'archived', status_label: 'Retired' }] });
    renderApp('/t/taazaa/offers/prc_ai/off_mb?edit=offer');
    const d = await drawer('Edit offer');
    expect(await within(d).findByText('Retired. Kept for history.')).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(within(d).getByLabelText('Title')).toBeDisabled();
  });
});

describe('Practice form (§19)', () => {
  it('creates a practice with a lead from the directory, then opens it', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers');
    await user.click(await screen.findByRole('button', { name: 'New practice' }));
    const d = await drawer('New practice');
    await user.click(within(d).getByRole('button', { name: 'Create practice' }));
    expect(within(d).getByText('Give the practice a name.')).toBeInTheDocument();
    await user.type(within(d).getByLabelText('Name'), 'AI Marketing Studio');
    await waitFor(() => expect(within(d).getByRole('option', { name: 'Maya Chen' })).toBeInTheDocument());
    await user.selectOptions(within(d).getByLabelText('Practice lead'), 'usr_maya');
    await user.type(within(d).getByLabelText('Positioning'), 'Campaigns that ship.');
    await user.click(within(d).getByRole('button', { name: 'Create practice' }));
    expect(await screen.findByText('AI Marketing Studio created. Add its first offer.')).toBeInTheDocument();
    expect(bodies(seen, 'POST', '/api/v1/practices')[0]).toEqual({ name: 'AI Marketing Studio', lead_user_id: 'usr_maya', description: 'Campaigns that ship.' });
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/offers/prc_new'));
  });

  it('edits a practice', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai');
    await user.click(await screen.findByRole('button', { name: 'Edit practice' }));
    const d = await drawer('Edit practice');
    expect(within(d).getByLabelText('Name')).toHaveValue('AI Transformation');
    await user.selectOptions(within(d).getByLabelText('Practice lead'), '');
    await user.click(within(d).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes to AI Transformation saved.')).toBeInTheDocument();
    expect(bodies(seen, 'PATCH', '/practices/prc_ai')[0]).toMatchObject({ lead_user_id: null });
  });
});
