import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { problem } from '../../test/http';
import { READER, serveOffers } from './testing';

const tree = () => screen.getByRole('navigation', { name: 'Practices' });

describe('Offers and practices (§19)', () => {
  it("shows each practice with the API's offer count and its offers with their status", async () => {
    serveOffers();
    renderApp('/t/taazaa/offers');
    await screen.findByRole('heading', { name: 'Offers and practices', level: 1 });
    const t = await waitFor(() => tree());
    expect(within(t).getByRole('link', { name: 'AI Transformation 2 offers' })).toBeInTheDocument();
    expect(within(t).getByRole('link', { name: 'Data Readiness 1 offer' })).toBeInTheDocument();
    expect(within(t).getByRole('link', { name: 'Modernization Blueprint Active' })).toBeInTheDocument();
    expect(within(t).getByRole('link', { name: 'Campaign Engine Sprint Draft' })).toBeInTheDocument();
    expect(within(t).getByRole('button', { name: 'New practice' })).toBeInTheDocument();
    expect(within(t).getByRole('button', { name: 'Add offer to AI Transformation' })).toBeInTheDocument();
  });

  it('opens on the first practice: lead line, positioning, and a card per offer with the stats line', async () => {
    serveOffers();
    renderApp('/t/taazaa/offers');
    expect(await screen.findByRole('heading', { name: 'AI Transformation', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Led by Ash Patel · 2 offers')).toBeInTheDocument();
    expect(screen.getByText('Plans that get funded.')).toBeInTheDocument();
    const card = (await screen.findByRole('link', { name: 'Modernization Blueprint' })).closest('li')!;
    expect(card).toHaveTextContent('Fixed fee · $85,000 · 6 weeks');
    expect(card).toHaveTextContent('A funded plan in six weeks.');
    await waitFor(() => expect(card).toHaveTextContent('38 accounts matched · 7 won'));
    const draft = screen.getAllByRole('link', { name: 'Campaign Engine Sprint' }).find((l) => l.closest('li')?.textContent?.includes('Custom quote'))!.closest('li')!;
    expect(draft).toHaveTextContent('No accounts matched yet');
    expect(draft).toHaveTextContent('Draft');
    for (const name of ['Delete practice', 'Edit practice', 'Add an offer to this practice']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('a practice without a lead says so', async () => {
    serveOffers();
    renderApp('/t/taazaa/offers/prc_data');
    expect(await screen.findByText('No lead yet · 1 offer')).toBeInTheDocument();
  });

  it('the offer view: breadcrumb, Updated line, price, the API stats and the sections, without the R2 parts', async () => {
    serveOffers();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    expect(await screen.findByRole('heading', { name: 'Modernization Blueprint', level: 2 })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(within(crumbs).getByRole('link', { name: 'AI Transformation' })).toBeInTheDocument());
    expect(crumbs).toHaveTextContent('Offer');
    expect(screen.getByText(/^Updated .* · Practice lead Ash Patel$/)).toBeInTheDocument();
    expect(screen.getByText('Fixed fee · $85,000 · 6 weeks')).toBeInTheDocument();
    const tiles = screen.getByRole('list', { name: 'Offer numbers' });
    await waitFor(() => expect(tiles).toHaveTextContent('38'));
    expect(tiles).toHaveTextContent('7');
    expect(tiles).toHaveTextContent('18%');
    expect(screen.getByText('Current, not yet attributed to outcomes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See accounts for this offer' })).toHaveAttribute('href', '/t/taazaa/accounts?offer=off_mb');
    expect(within(screen.getByRole('region', { name: 'Summary' })).getByText('A funded plan in six weeks.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Ideal customer' })).getByText('Agencies with a mandate.')).toBeInTheDocument();
    for (const name of ['Key offer', 'Why us', 'Why now']) expect(within(screen.getByRole('region', { name })).getByRole('button', { name: 'Add it' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Proof points' })).getByText('Plan approved in 7 weeks')).toBeInTheDocument();
    for (const r2 of ['Playbook by tier', 'Initial message', 'Seller guide', 'Talking points']) expect(screen.queryByText(r2)).toBeNull();
  });

  it('Retire when the offer has history: confirm, then the toast', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.click(await screen.findByRole('button', { name: 'Retire' }));
    const dialog = screen.getByRole('dialog', { name: 'Retire Modernization Blueprint?' });
    expect(dialog).toHaveTextContent("Scout stops matching accounts to it. Accounts already matched keep it. You can't undo this.");
    await user.click(within(dialog).getByRole('button', { name: 'Retire offer' }));
    expect(await screen.findByText('Modernization Blueprint retired.')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'POST' && r.url.pathname.endsWith('off_mb:archive'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('Delete when the offer never matched: confirm, DELETE, back to the practice', async () => {
    const seen = serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai/off_sprint');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Campaign Engine Sprint?' });
    expect(dialog).toHaveTextContent('It never matched an account, so nothing else changes.');
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Delete offer' }));
    expect(await screen.findByText('Campaign Engine Sprint deleted.')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'DELETE' && r.url.pathname === '/api/v1/offers/off_sprint')).toBe(true);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/offers/prc_ai'));
  });

  it("Delete practice confirms, and a blocked one shows the API's title", async () => {
    serveOffers({ answer: { 'prc_ai:archive': () => problem(409, 'Retire or move its active offers first.', { slug: 'practice-has-offers' }) } });
    const user = userEvent.setup();
    renderApp('/t/taazaa/offers/prc_ai');
    await user.click(await screen.findByRole('button', { name: 'Delete practice' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete AI Transformation?' });
    expect(dialog).toHaveTextContent('Its draft and retired offers stay in the history.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete practice' }));
    expect(await screen.findByText('Retire or move its active offers first.')).toBeInTheDocument();
  });

  it('Delete practice that is allowed deletes it and goes back to Offers', async () => {
    serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai');
    await user.click(await screen.findByRole('button', { name: 'Delete practice' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete practice' }));
    expect(await screen.findByText('AI Transformation deleted.')).toBeInTheDocument();
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/offers'));
  });

  it('"Not written yet. Add it" opens the form at that section', async () => {
    serveOffers();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/offers/prc_ai/off_mb');
    await user.click(await within(await screen.findByRole('region', { name: 'Why us' })).findByRole('button', { name: 'Add it' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit offer' });
    expect(app.path()).toContain('edit=offer');
    expect(app.path()).toContain('field=why_us');
    await waitFor(() => expect(within(drawer).getByLabelText('Why us')).toHaveFocus());
  });

  it('people with offers:read only see no edit, create, retire or delete controls', async () => {
    serveOffers({ scopes: READER });
    renderApp('/t/taazaa/offers/prc_ai/off_mb');
    expect(await screen.findByRole('heading', { name: 'Modernization Blueprint', level: 2 })).toBeInTheDocument();
    for (const name of ['New practice', 'Duplicate', 'Retire', 'Delete', 'Edit offer', 'Add it']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add offer to/ })).toBeNull();
    expect(screen.getAllByText('Not written yet.').length).toBeGreaterThan(0);
    // Drafts are left out by the API, so the tree has only the active ones.
    expect(within(tree()).queryByRole('link', { name: /Campaign Engine Sprint/ })).toBeNull();
  });

  it('a hidden or missing offer shows the load error', async () => {
    serveOffers({ scopes: READER });
    renderApp('/t/taazaa/offers/prc_ai/off_sprint');
    expect(await screen.findByText("This offer didn't load")).toBeInTheDocument();
  });

  it('Retire is the choice for an offer the API says cannot be deleted, even with no matches', async () => {
    serveOffers({ detail: { off_sprint: { can_delete: false } } });
    renderApp('/t/taazaa/offers/prc_ai/off_sprint');
    expect(await screen.findByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
