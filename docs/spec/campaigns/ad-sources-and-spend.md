# CMP-E3 Ad sources and spend

Release R4 · Module CMP

## Why

Ads are one source among many. Their spend has to land in the same cost ledger and their form fills in
the same funnel, so the CRO compares paid ads with agents, vendors and partners on equal terms.

## Rules

- Each connected ad channel (Meta, LinkedIn, Google Ads) is a vendor-level source in Sources and
  intake, created per tenant when the channel is connected. Each campaign can be an agent-level source
  under it if the tenant wants that detail.
- A daily job pulls spend, impressions and clicks per campaign and per message test ad set into
  `campaigns.ad_spend_day`, then publishes `campaigns.ad_spend.recorded` per row; Analytics turns it into
  an auto cost line targeted at the source.
- Closed-won deals for accounts whose first source is an ad source are sent to that ad channel as
  offline conversions (carried from v1), once per deal.

## Stories

### CMP-E3-S1 Ad spend in the ledger
As a CRO, I want ad spend in the same cost ledger as everything else, so that cost per won client by
source is comparable.
- CMP-E3-S1-AC1 Each day's spend per campaign appears as one cost line, even if the pull runs twice.
- CMP-E3-S1-AC2 Spend corrections from the channel (it restates a day) void the old line and add the new.

### CMP-E3-S2 Offline conversions
As an operator, I want won deals sent back to the ad channel, so that its bidding learns.
- CMP-E3-S2-AC1 Each won deal from an ad-sourced account is sent once and the send is logged; failures
  retry and show in the integration call log.
