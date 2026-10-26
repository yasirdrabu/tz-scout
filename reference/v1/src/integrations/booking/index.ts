// Booking links. The mock returns a link into this app's own "book a time" page so the flow can be
// clicked through end to end; live uses the owner's HubSpot meetings link.

import { modeOf } from "../mode";

export interface BookingAdapter {
  readonly mode: "mock" | "live";
  bookingLink(input: { leadId: string; ownerEmail: string | null; companySlug: string }): Promise<string>;
}

const mock: BookingAdapter = {
  mode: "mock",
  async bookingLink({ leadId, companySlug }) {
    const base = process.env.NEXTAUTH_URL ?? "http://localhost:4240";
    return `${base}/book/${companySlug}/${leadId}`;
  },
};

const live: BookingAdapter = {
  mode: "live",
  async bookingLink({ ownerEmail }) {
    const base = process.env.BOOKING_URL_BASE ?? "https://meetings.hubspot.com/";
    const handle = (ownerEmail ?? "").split("@")[0]!.replace(/\./g, "-");
    return `${base}${handle}`;
  },
};

export function bookingAdapter(): BookingAdapter {
  return modeOf("booking") === "live" ? live : mock;
}
