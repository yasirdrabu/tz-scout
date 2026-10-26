# Migration and rollout

Not a runtime module. This folder says how today's system (v1, "Client Acquisition", running on one
laptop against live HubSpot) becomes Taazaa Scout without losing data or a working day.

| File | Covers |
|---|---|
| [data-migration.md](data-migration.md) | Every v1 table mapped to its new module and table; the idempotent migration command; verification |
| [release-plan.md](release-plan.md) | R0 to R4 scope per module, exit criteria, parallel tracks, rename, cutover from laptop to VM, key rotation |
| [retiring-spec-v1.md](retiring-spec-v1.md) | What happens to `docs/SPEC.md`, and where each v1 module went |

## Principles

- v1 keeps running until R1 is accepted on the VM. No big-bang switch before that.
- The migration is a command that can run many times (idempotent), against a copy first.
- Nothing about the migration needs the v1 code to change.
- The cutover is reversible for 14 days: v1's database is kept read-only as a backup.

## Epics

| Epic | Where | Release |
|---|---|---|
| MIG-E1 Migrate v1 data | data-migration.md | R1 |
| MIG-E2 Cut over to the VM | release-plan.md | R1 |
