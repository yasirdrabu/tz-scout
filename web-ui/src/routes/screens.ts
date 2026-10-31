/** Each placeholder names its screen, its section in docs/spec/web-ui/screens.md and its release tag. */
export type Screen = { title: string; section: string; tag: string };

export const SCREENS = {
  queue: { title: 'Review queue', section: '2', tag: 'R1' },
  my: { title: 'My accounts', section: '7', tag: 'R1' },
  accounts: { title: 'All accounts', section: '8', tag: 'R1' },
  account: { title: 'Account page', section: '4', tag: 'R1' },
  overview: { title: 'Overview', section: '9', tag: 'R3' },
  sources: { title: 'Sources', section: '10', tag: 'R1' },
  batches: { title: 'Batches and imports', section: '13', tag: 'R1' },
  offers: { title: 'Offers and practices', section: '19', tag: 'R1' },
  playbooks: { title: 'Playbooks', section: '20', tag: 'R2' },
  funnel: { title: 'Funnel by source', section: '16', tag: 'R3' },
  costs: { title: 'Costs', section: '18', tag: 'R3' },
  profile: { title: 'Profile', section: '25', tag: 'R1' },
  adminTenants: { title: 'Tenants', section: '22', tag: 'R1' },
  adminHealth: { title: 'System health', section: '24', tag: 'R1' },
  adminAiRuns: { title: 'AI runs', section: '23', tag: 'R1' },
} satisfies Record<string, Screen>;

export type ScreenKey = keyof typeof SCREENS;
