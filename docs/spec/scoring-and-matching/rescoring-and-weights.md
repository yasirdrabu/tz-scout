# SCO-E5 Rescoring and tenant weights

Release R1 (event-driven rescoring), R2 (weights editor)

## Why

Scores go stale when facts arrive, signals age, rules change or a source earns or loses trust. Replay
in Scout means recomputing scores from stored facts (D11), quickly and without anyone asking.

## Rules

- Scoring one account is a pure function of (account facts, people, signals, research tier, approved
  offers and their rules, warm intro, trust, profile, `now`). `inputs_hash` is a hash of everything
  except `now`; a rescore whose hash and day are unchanged skips the write.
- **Triggers** are the consumed events in the module index. Single-account triggers run in the
  consumer; tenant-wide triggers enqueue `jobs.rescore.accounts` jobs of 500 ids.
- **Ageing.** Signals fade with time, so a nightly job (02:00 UTC) rescores accounts that have at least
  one signal younger than 365 days and were last scored more than 20 hours ago.
- **Throughput target:** 10,000 accounts rescored in under 5 minutes on one worker.
- **Concurrency:** consumers are ordered by account; two rescores of one account never run at once.

## Stories

### SCO-E5-S1 Rescore on new facts and signals
- SCO-E5-S1-AC1 Within 5 seconds of `accounts.signal.recorded`, the account's score reflects the
  signal (p95, single worker, normal load).
- SCO-E5-S1-AC2 A rescore that changes nothing publishes no event and writes no `score_change`.

### SCO-E5-S2 Rescore when rules, offers or trust change
- SCO-E5-S2-AC1 Approving a new offer rescores every account in its practice; accounts whose best
  offer changes publish `scoring.account.scored` with `previousBestOfferId`.
- SCO-E5-S2-AC2 Archiving an offer removes its matches and rescores; no account keeps an archived best
  offer.
- SCO-E5-S2-AC3 A trust change for a source rescores only that source's accounts.

### SCO-E5-S3 Edit weights and thresholds (R2)
As an owner, I want to tune how fit and intent weigh, so that the ranking matches what we learn.
- SCO-E5-S3-AC1 Settings → Scoring shows fit and intent weights, fit part maxes, half-life, tier
  thresholds, warm intro cap and trust modifier range, each with its default beside it.
- SCO-E5-S3-AC2 Before saving, a preview shows how many accounts would change tier (computed on the
  current data without writing).
- SCO-E5-S3-AC3 Saving publishes `scoring.rules.changed`; the queue shows "Rescoring 342 accounts"
  until done.
- SCO-E5-S3-AC4 Fit part maxes that don't add to 100, or weights that are both 0, are rejected with a
  message saying what to fix.
- SCO-E5-S3-AC5 Every save is in the audit log with before and after values; "Reset to defaults" is
  available.

### SCO-E5-S4 Manual rescore
- SCO-E5-S4-AC1 An owner can rescore the whole tenant or a filter (practice, source) from Settings or
  `POST /api/v1/rescore` (scope `scoring:manage`); progress is visible.
