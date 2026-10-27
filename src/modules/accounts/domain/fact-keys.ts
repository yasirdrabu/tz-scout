// How a fact key's values combine. The list of known keys is in contracts/types.ts.

const LIST_KEYS = ['technologies', 'keywords'];
const FREE_TEXT_KEYS = ['description', 'hook', 'problem', 'pilot', 'value_hypothesis', 'incumbent', 'caveats', 'contact_route', 'next_action'];

/** Values from every source are merged. */
export const isListKey = (key: string) => LIST_KEYS.includes(key);

/** Never conflicts: the newest value is current and earlier ones are history. */
export const isFreeTextKey = (key: string) => FREE_TEXT_KEYS.includes(key);
