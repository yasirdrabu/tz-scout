import { modeOf } from "../mode";
import { createApolloAdapter } from "./apollo";
import { createMockProspects } from "./mock";
import type { ProspectAdapter } from "./types";

export function prospectsAdapter(): ProspectAdapter {
  return modeOf("prospects") === "live" ? createApolloAdapter() : createMockProspects();
}

export function maxCreditsPerRun(): number {
  const n = Number(process.env.APOLLO_MAX_CREDITS_PER_RUN ?? 150);
  return Number.isFinite(n) && n > 0 ? n : 150;
}

export * from "./types";
export { ApolloCreditsError } from "./apollo";
