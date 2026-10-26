// Email and SMS. The mock "sends" by returning an id; the touch record keeps the full body so
// every message is visible on the meeting timeline.

import { hashString } from "@/lib/rand";
import { modeOf, NotConnectedError, requireEnv } from "../mode";

export type OutboundMessage = { channel: "EMAIL" | "SMS"; to: string; subject?: string | null; body: string };

export interface MessagingAdapter {
  readonly mode: "mock" | "live";
  send(m: OutboundMessage): Promise<{ id: string }>;
}

const mock: MessagingAdapter = {
  mode: "mock",
  async send(m) {
    return { id: `msg_mock_${hashString(m.to + m.body).toString(36)}` };
  },
};

const live: MessagingAdapter = {
  mode: "live",
  async send() {
    requireEnv("messaging", "MESSAGING_FROM_EMAIL");
    throw new NotConnectedError("messaging", "pick an email and SMS provider before going live");
  },
};

export function messagingAdapter(): MessagingAdapter {
  return modeOf("messaging") === "live" ? live : mock;
}
