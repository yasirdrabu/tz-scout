# CMP-E5 Booking and reminders

Release R4 · Module CMP · Carried from v1 Module 6

## Why

Booked calls that don't happen waste the whole funnel. A booking link, timely reminders and a rebook
sequence raise show-up rates.

## Rules (carried)

- After an account is assigned (if the tenant turns on "Send booking link on assignment"), or when a
  seller presses "Send booking link", the primary person gets a booking link.
- On booking: confirmation, reminders at 24 hours and 1 hour (email; SMS only where consented), and a
  pre-call note with one case study matched by industry.
- No-show: rebook sequence of 3 touches over 7 days.
- Meeting statuses: booked, held, no-show, rebooked, cancelled.
- Timing is configurable per tenant.
- Every touch and outcome is logged as a meeting record and synced to the CRM as an activity.
- Held meetings publish `campaigns.meeting.held`; Playbooks records an outcome of kind meeting, which
  moves the account to Engaged.
- Show-up rates by week feed the ad funnel model (CMP-E2) and the scorecard (ANL-E5).

## Stories

### CMP-E5-S1 Booking link and confirmation
- CMP-E5-S1-AC1 Sending the link creates a scheduled touch; booking through the provider (or the mock
  booking page) creates a meeting with status booked and a confirmation touch.

### CMP-E5-S2 Reminders
- CMP-E5-S2-AC1 Reminders are scheduled at 24 hours and 1 hour before; SMS only when the person
  consented; cancelled or rescheduled meetings cancel or move their reminders.

### CMP-E5-S3 No-show and rebook
- CMP-E5-S3-AC1 Marking no-show starts 3 rebook touches over 7 days; a new booking stops the sequence and
  links the meetings.

### CMP-E5-S4 Timing settings
- CMP-E5-S4-AC1 Owners can change every delay in Settings; changes apply to touches not yet sent.
