// Live Meta Marketing API adapter. Milestone 9. Until then every call reports "not connected"
// so the UI can say so plainly instead of failing.

import { NotConnectedError, requireEnv } from "../mode";
import type { AdChannelAdapter } from "../ads/types";

export function createLiveMeta(): AdChannelAdapter {
  const notYet = async (): Promise<never> => {
    requireEnv("meta", "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID");
    throw new NotConnectedError("meta", "live Meta adapter is scheduled for milestone 9");
  };
  return {
    channel: "meta",
    mode: "live",
    launchTest: notYet,
    getResults: notYet,
    getDailyStats: notYet,
    sendConversion: notYet,
  };
}
