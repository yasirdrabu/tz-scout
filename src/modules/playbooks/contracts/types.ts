// Types other modules may see. They never see this module's tables.

/** Every section key the R1 brief stores (Ruling 1). */
export const BRIEF_KEYS = ['overview', 'approach', 'value_angle', 'risks', 'why_now'] as const;
export type BriefKey = (typeof BRIEF_KEYS)[number];

/** The four sections the account page shows, in order. `why_now` is stored, but the page's Why now is the signal list. */
export const PAGE_SECTIONS = [
  { key: 'overview', title: 'Overview' },
  { key: 'approach', title: 'Approach' },
  { key: 'value_angle', title: 'Value angle' },
  { key: 'risks', title: 'Risks' },
] as const satisfies readonly { key: BriefKey; title: string }[];
export type PageSectionKey = (typeof PAGE_SECTIONS)[number]['key'];

export const SECTION_MAX = 4000;

export type BriefOrigin = 'ai' | 'rules' | 'human';
export type BriefMode = 'live' | 'mock' | 'rules';
export type DraftState = 'not_drafted' | 'drafting' | 'ready';
