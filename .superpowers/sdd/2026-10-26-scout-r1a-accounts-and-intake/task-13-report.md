# Task 13 report

Implemented: `src/modules/intake/import/synonyms.ts` (allowed target list `isAllowedTarget`, `synonymMapping`, `cleanMapping`, 0.6 floor, schemas), `tasks/arrival-normalise.ts` (`arrivalNormaliseTask`, `normaliseWithAi`), `tasks/csv-column-mapping.ts` (`csvColumnMappingTask`, `suggestMapping`). Model id: `claude-haiku-5-5` (matches pricing table and runner tests; no prior task existed).

Notes:
- Synonym matching: exact alias 0.9, contains-alias 0.7 (longest alias wins, so "Company Website URL" is website, not name). Each target used once.
- `suggestMapping` returns origin `ai` only when mode is `live`; rules, mock or any ScoutError give `synonyms`.
- Disallowed targets and columns under 0.6 get target null (header kept).

TDD
- RED: `npm run test:unit -- synonyms` and `npm run test:int -- intake/tasks` -> "1 failed, no tests" (modules missing, expected).
- GREEN: synonyms 4/4, intake/tasks 4/4. Full: typecheck and lint clean; `npm test` 43 files, 396 passed, 1 skipped.

Files: the three src files and two test files above. No others touched.

## Fix round 1
- `cleanMapping` now keeps the highest-confidence column per target (tie: first header). `signals[].*` is exempt because it is repeatable; `people[n]` and `custom_fields.<key>` are single-valued per path. Rule is in the doc comment.
- Unit tests added: Company/Account both to account.name keeps the higher one; ties; repeatable signals; `people[1].email` kept.
- `normaliseWithAi` and `suggestMapping` now catch every error, log at warn (`log`, `errorText`) and return nulls / synonyms.
- No test for a non-ScoutError: the runner wraps adapter errors into `ai_failed` (a ScoutError), so a stub cannot reach that branch without mocking runTask or internals; I tried a JSON.stringify spy and dropped it as meaningless.
- Ran: `npm run test:unit -- synonyms` 6/6, `npm run test:int -- intake/tasks` 4/4, typecheck and lint clean.
