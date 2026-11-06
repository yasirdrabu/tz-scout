import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { visibleSettingsTabs } from '../../../app/nav';
import { exactly, problem } from '../../../test/http';
import { ME, renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { Draft, Preview, Profile } from './api';
import { balance } from './draft';

const DEFAULTS: Draft = { weights: { fit: 40, intent: 25, revenue: 15, trust: 20 }, tier_cutoffs: { act_now: 75, good_fit: 55, watch: 35 } };
const PROFILE: Profile = {
  weights: { fit: 50, intent: 25, revenue: 10, trust: 15 },
  tier_cutoffs: { act_now: 80, good_fit: 60, watch: 40 },
  defaults: DEFAULTS,
  version: 4,
};
const PREVIEW: Preview = {
  before: { act_now: 4, good_fit: 9, watch: 12, nurture: 20, not_fit: 3 },
  after: { act_now: 6, good_fit: 8, watch: 12, nurture: 19, not_fit: 3 },
  samples: [
    { account_id: 'a1', name: 'Miami-Dade County DTPW', fit: 80, intent: 40, revenue: 50, trust: 60, score_before: 58, score_after: 62, tier_before: 'watch', tier_after: 'good_fit' },
    { account_id: 'a2', name: 'Pinegate University', fit: 30, intent: 10, revenue: 50, trust: 60, score_before: 30, score_after: 28, tier_before: 'nurture', tier_after: 'nurture' },
  ],
};

let puts: unknown[] = [];
let previews: Draft[] = [];

function serve(opts: { scopes?: string[]; put?: () => Response | undefined } = {}) {
  puts = [];
  previews = [];
  serveMe({ taazaa: { scopes: opts.scopes ?? ['scoring:manage'] } });
  server.use(
    http.get('/api/v1/scoring/profile', () => HttpResponse.json(PROFILE)),
    http.put('/api/v1/scoring/profile', async ({ request }) => {
      const body = (await request.json()) as Partial<Draft>;
      puts.push(body);
      const answer = opts.put?.();
      if (answer) return answer;
      return HttpResponse.json({ ...PROFILE, ...body, version: 5 }, { status: 202 });
    }),
    http.post(exactly('/api/v1/scoring/profile:preview'), async ({ request }) => {
      previews.push((await request.json()) as Draft);
      return HttpResponse.json(PREVIEW);
    }),
    http.get('/api/v1/ai-runs', () => HttpResponse.json({ data: [], totals: [] })),
  );
}

const open = async () => {
  renderApp('/t/taazaa/settings/scoring-weights');
  await screen.findByRole('slider', { name: 'Fit' });
};
const slide = (name: string, value: number) => fireEvent.change(screen.getByRole('slider', { name }), { target: { value: String(value) } });
const cutoff = (name: string, value: string) => fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } });
const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);

describe('balance', () => {
  it('scales the others to 100 in steps of 5 by largest remainder and keeps the moved one', () => {
    expect(balance({ fit: 60, intent: 25, revenue: 15, trust: 20 }, 'fit')).toEqual({ fit: 60, intent: 15, revenue: 10, trust: 15 });
    expect(balance({ fit: 40, intent: 25, revenue: 15, trust: 20 }, 'fit')).toEqual({ fit: 40, intent: 25, revenue: 15, trust: 20 });
    expect(balance({ fit: 10, intent: 10, revenue: 10, trust: 10 }, 'trust')).toEqual({ fit: 30, intent: 30, revenue: 30, trust: 10 });
  });

  it('stays within 0 to 60 in steps of 5 and adds to 100', () => {
    for (const [w, fixed] of [
      [{ fit: 0, intent: 60, revenue: 5, trust: 0 }, 'revenue'],
      [{ fit: 0, intent: 0, revenue: 0, trust: 0 }, 'fit'],
      [{ fit: 60, intent: 60, revenue: 60, trust: 60 }, 'fit'],
    ] as const) {
      const out = balance(w, fixed);
      expect(sum(out)).toBe(100);
      expect(Object.values(out).every((v) => v % 5 === 0 && v >= 0 && v <= 60)).toBe(true);
      expect(out[fixed]).toBe(w[fixed]);
    }
  });
});

describe('Settings > Scoring weights', () => {
  it('shows the sliders with what feeds each, the total chip and the cutoffs from the API', async () => {
    serve();
    await open();
    expect(screen.getByText(/^Every account gets a priority score from 0 to 100\./)).toBeInTheDocument();
    for (const [name, value] of [['Fit', 50], ['Buying intent', 25], ['Revenue potential', 10], ['Source trust', 15]] as const) {
      const s = screen.getByRole('slider', { name });
      expect(s).toHaveValue(String(value));
      expect(s).toHaveAttribute('min', '0');
      expect(s).toHaveAttribute('max', '60');
      expect(s).toHaveAttribute('step', '5');
    }
    expect(screen.getByText("Learned nightly from what each source's accounts became.")).toBeInTheDocument();
    expect(screen.getByText('Adds up to 100')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Act now' })).toHaveValue(80);
    expect(screen.getByRole('spinbutton', { name: 'Good fit' })).toHaveValue(60);
    expect(screen.getByRole('spinbutton', { name: 'Watch' })).toHaveValue(40);
    expect(screen.getByText(/^Saving rescores every account in this workspace/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and rescore' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('warns when the weights do not add to 100, and Balance to 100 fixes the slider just moved and scales the rest', async () => {
    serve();
    const user = userEvent.setup();
    await open();
    slide('Fit', 60);
    expect(screen.getByText('Weights add up to 110. Make them add up to 100.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and rescore' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Balance to 100' }));
    expect(screen.getByText('Adds up to 100')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Fit' })).toHaveValue('60');
    expect(screen.getByRole('slider', { name: 'Buying intent' })).toHaveValue('20');
    expect(screen.getByRole('slider', { name: 'Revenue potential' })).toHaveValue('10');
    expect(screen.getByRole('slider', { name: 'Source trust' })).toHaveValue('10');
  });

  it('says what is wrong with the cutoffs, does not save, and does not ask for a preview', async () => {
    serve();
    await open();
    cutoff('Good fit', '80');
    expect(screen.getByText('Act now has to start higher than Good fit.')).toBeInTheDocument();
    cutoff('Good fit', '50');
    cutoff('Watch', '50');
    expect(screen.getByText('Good fit has to start higher than Watch.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and rescore' })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 600));
    expect(previews).toHaveLength(0);
  });

  it('asks for one preview 400 ms after the last change and shows the counts and the sample accounts', async () => {
    serve();
    await open();
    slide('Fit', 45);
    slide('Buying intent', 30);
    expect(previews).toHaveLength(0);
    const changes = screen.getByRole('region', { name: 'What changes' });
    const tiers = await within(changes).findByRole('table', { name: 'Accounts in each tier' });
    expect(previews).toEqual([{ weights: { fit: 45, intent: 30, revenue: 10, trust: 15 }, tier_cutoffs: PROFILE.tier_cutoffs }]);
    expect(within(within(tiers).getByRole('row', { name: /Act now/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual(['4', '6']);
    expect(within(within(tiers).getByRole('row', { name: /Nurture/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual(['20', '19']);
    const samples = within(changes).getByRole('table', { name: 'Sample accounts' });
    const miami = within(samples).getByRole('row', { name: /Miami-Dade County DTPW/ });
    expect(miami).toHaveTextContent('62');
    expect(miami).toHaveTextContent('+4');
    expect(miami).toHaveTextContent('Watch');
    expect(miami).toHaveTextContent('Good fit');
    expect(within(samples).getByRole('row', { name: /Pinegate University/ })).toHaveTextContent('−2');
  });

  it('Restore defaults fills the draft without saving; Save and rescore sends only what changed and shows the toast', async () => {
    serve();
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(screen.getByRole('slider', { name: 'Fit' })).toHaveValue('40');
    expect(screen.getByRole('spinbutton', { name: 'Watch' })).toHaveValue(35);
    expect(puts).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('slider', { name: 'Fit' })).toHaveValue('50');

    slide('Fit', 55);
    slide('Buying intent', 20);
    await user.click(screen.getByRole('button', { name: 'Save and rescore' }));
    expect(await screen.findByText('Rescoring started.')).toBeInTheDocument();
    expect(puts).toEqual([{ weights: { fit: 55, intent: 20, revenue: 10, trust: 15 } }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and rescore' })).toBeDisabled());

    cutoff('Watch', '30');
    await user.click(screen.getByRole('button', { name: 'Save and rescore' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ tier_cutoffs: { act_now: 80, good_fit: 60, watch: 30 } });
  });

  it('shows the API words when the save is refused', async () => {
    serve({ put: () => problem(400, 'Check the scoring settings.', { slug: 'validation' }) });
    const user = userEvent.setup();
    await open();
    slide('Fit', 55);
    slide('Buying intent', 20);
    await user.click(screen.getByRole('button', { name: 'Save and rescore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the scoring settings.');
    expect(screen.queryByText('Rescoring started.')).toBeNull();
  });

  it('is hidden without scoring:manage, and a direct visit says the tab is not open', async () => {
    expect(visibleSettingsTabs({ ...ME, scopes: ['settings:manage'] }).map((t) => t.tab)).not.toContain('scoring-weights');
    expect(visibleSettingsTabs({ ...ME, scopes: ['scoring:manage'] }).map((t) => t.tab)).toContain('scoring-weights');
    serve({ scopes: ['settings:manage'] });
    renderApp('/t/taazaa/settings/scoring-weights');
    expect(await screen.findByText("This tab isn't open to you")).toBeInTheDocument();
  });
});
