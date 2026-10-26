# INT-E2 Encrypted credentials

Release R1

## Why

Owners type keys into the app (D18). Keys pasted into chat or env files have leaked before (HANDOFF
security notes); keys in the database must be useless if the database alone is copied.

## Rules

- **Envelope encryption.** Each credential is encrypted with its own random 256-bit data key using
  AES-256-GCM. The data key is wrapped (encrypted) with the master key `SCOUT_MASTER_KEY` (32 bytes,
  base64, from the environment or a key vault). Stored: ciphertext, IV, auth tag, wrapped data key,
  `key_version`.
- `SCOUT_MASTER_KEY_PREVIOUS` may be set during rotation; reads try the current key version first.
  A rotation job re-wraps every data key with the new master key without decrypting the credential
  value to anyone.
- Decrypted values exist only in memory inside `gateway.call`, are never logged, never returned by any
  API, and never sent to the browser. The UI shows only a hint (last 4 characters) and when it was
  set.
- Replacing a credential keeps the old one for 1 hour so in-flight jobs finish, then deletes it.
- The app refuses to start in production without `SCOUT_MASTER_KEY`.

## Stories

### INT-E2-S1 Enter a credential
As an owner, I want to paste a key and save it securely, so that Scout can call the service.
- INT-E2-S1-AC1 After saving, the field shows "Saved. Ends in 4f2a." and never the full value.
- INT-E2-S1-AC2 The database row contains no readable part of the key except the 4-character hint.
- INT-E2-S1-AC3 Saving runs a test automatically and shows the result.

### INT-E2-S2 Rotate the master key
As a platform admin, I want to rotate the master key, so that a suspected leak can be contained.
- INT-E2-S2-AC1 With both keys set, `scout migrate --rewrap-credentials` re-wraps every data key and
  reports the count; afterwards the previous key can be removed and every credential still decrypts.

### INT-E2-S3 Credential expiry
As an owner, I want to be warned before a credential expires (when the provider says when), so that
calls don't stop.
- INT-E2-S3-AC1 Credentials with `expires_at` produce a notice 14 and 3 days before.
