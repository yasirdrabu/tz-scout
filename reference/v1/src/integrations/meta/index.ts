import { modeOf } from "../mode";
import { createMockChannel } from "../ads/mockChannel";
import { createLiveMeta } from "./live";
import type { AdChannelAdapter } from "../ads/types";

export function metaAdapter(): AdChannelAdapter {
  return modeOf("meta") === "live" ? createLiveMeta() : createMockChannel("meta");
}
