// One place to get every adapter for a company. Each picks mock or live from env vars.

import type { ScopedDb } from "@/lib/db";
import { audit } from "@/server/audit";
import { anthropicAdapter } from "./anthropic";
import { bookingAdapter } from "./booking";
import { companyDataAdapter } from "./companyData";
import { googleAdsAdapter } from "./googleAds";
import { hubspotAdapter } from "./hubspot";
import { linkedinAdapter } from "./linkedin";
import { messagingAdapter } from "./messaging";
import { metaAdapter } from "./meta";
import type { AdChannelAdapter } from "./ads/types";

export function adapters(db: ScopedDb, companyId: string) {
  return {
    hubspot: hubspotAdapter((action, data) => audit(db, companyId, { action, entity: "hubspot", data })),
    meta: metaAdapter(),
    linkedin: linkedinAdapter(),
    googleAds: googleAdsAdapter(),
    companyData: companyDataAdapter(),
    booking: bookingAdapter(),
    messaging: messagingAdapter(),
    anthropic: anthropicAdapter(),
  };
}

export type Adapters = ReturnType<typeof adapters>;

export function adChannel(a: Adapters, channel: string): AdChannelAdapter {
  return channel === "linkedin" ? a.linkedin.channel() : a.meta;
}

export { PROVIDERS, PROVIDER_LABEL, modeOf, NotConnectedError } from "./mode";
