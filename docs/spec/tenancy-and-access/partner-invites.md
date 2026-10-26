# TEN-E5 Partner invites

Release R4

## Why

Partners and vendors send accounts with keys from R1. Later they need to sign in to see what happened
to what they sent, without seeing anything else.

## Rules

- A partner is a member with `kind = partner`, role `partner`, and a data limit fixed to the sources
  they own. The role allows `arrivals:write`, `arrivals:read`, `status:read`, `imports:run` (into their
  source only) and nothing else.
- Partners sign in with Microsoft or with an email one-time code (better-auth magic link); no
  passwords.
- A partner can create API keys only for their own sources, with scopes no wider than their own.
- Partner names appear on their sources; reps see "From partner: <name>".

## Stories

### TEN-E5-S1 Invite a partner
As an owner, I want to invite a partner and tie them to their source, so that they can follow their
submissions.
- TEN-E5-S1-AC1 The invite asks for email, partner organisation name and the source(s) they own.
- TEN-E5-S1-AC2 The invite link expires after 7 days and works once.

### TEN-E5-S2 Partner view
As a partner, I want a page with my submissions and their stages, so that I know what converted.
- TEN-E5-S2-AC1 Shows batches, arrivals and accounts from my sources with stage (arrived, reviewed,
  assigned, engaged, opportunity, won, lost, declined) and no contact details of people I didn't send.
- TEN-E5-S2-AC2 Decline reasons are shown only in the categories the tenant marks "shareable with
  partners".

### TEN-E5-S3 Partner keys
As a partner, I want to create keys for my own systems, so that I don't wait on the tenant owner.
- TEN-E5-S3-AC1 Allowed only when the owner turned on "Partners can create their own keys".
