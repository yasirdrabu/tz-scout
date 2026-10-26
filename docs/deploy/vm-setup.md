# Deploying Scout to the Ubuntu VM with OpenTofu

Status: draft for review · Target: `https://scout.taazaa.ai` · Updated 2026-10-26

This is the checklist for putting Scout on the existing Ubuntu VM. OpenTofu runs on your laptop. It does
not create the VM; it configures the one you already have over SSH and sets up Cloudflare in front of it.

## What OpenTofu will do

One `tofu apply` will:

1. **Cloudflare:** create a tunnel and the `scout.taazaa.ai` DNS record pointing at it. No public IP,
   open inbound ports or firewall changes are needed on the VM.
2. **Secrets:** generate the database passwords, the sign-in secret and the encryption master key.
3. **The VM (over SSH):** install Docker, write `/opt/scout/.env` and the compose file, log in to the
   GitHub image registry, run the database migration, and start Scout.

Later updates use the `deploy-staging` GitHub workflow: pull a new image tag, migrate, restart.

## Keep secrets out of chat

Keys, tokens and passwords go into a local file (`infra/tofu/envs/prod/terraform.tfvars`) that git
ignores. Claude reads the file through OpenTofu on your laptop and never needs the values in chat.

## Steps

### 1. VM details (share these, none are secret)

| Item | How to check | Value |
|---|---|---|
| IP address or hostname reachable from your laptop | | |
| SSH user | | |
| Passwordless sudo for that user? | `sudo -n true && echo yes` | |
| Ubuntu version | `lsb_release -a` | |
| Outbound access to `ghcr.io`, `github.com`, `download.docker.com`, Cloudflare | `curl -sI https://ghcr.io` etc. | |
| CPU, memory, free disk | `nproc`, `free -h`, `df -h /` | |

Recommended minimum: 2 CPUs, 4 GB memory, 40 GB free disk.

### 2. SSH key (on your laptop)

```
ssh-keygen -t ed25519 -f ~/.ssh/scout_vm -C scout-deploy
```

- Copy the contents of `~/.ssh/scout_vm.pub` into `~/.ssh/authorized_keys` for the SSH user on the VM.
- Test: `ssh -i ~/.ssh/scout_vm <user>@<vm>`
- Share only the path (`~/.ssh/scout_vm`), never the private key.

### 3. Install OpenTofu (on your laptop)

```
winget install OpenTofu.Tofu
tofu version
```

### 4. Cloudflare

In the Cloudflare dashboard:

- Create an API token with exactly these permissions:
  - Zone, DNS, Edit, limited to `taazaa.ai`
  - Account, Cloudflare Tunnel, Edit
- Note the **account ID** and the **zone ID** for `taazaa.ai` (both on the zone's overview page).

### 5. GitHub token for pulling images

- Create a classic personal access token with only `read:packages`.
- The VM uses it to pull `ghcr.io/yasirdrabu/tz-scout` and `ghcr.io/yasirdrabu/tz-scout-backup`.
- Set an expiry and a reminder to rotate it.

### 6. Microsoft sign-in (Entra ID)

This can wait until after the first deploy; Scout runs without it, but nobody can sign in until it is set.

- App registrations, New registration: single tenant, platform **Web**.
- Redirect URI: `https://scout.taazaa.ai/api/auth/callback/microsoft`
- API permissions: keep the defaults (`openid`, `profile`, `email`, `User.Read`) and grant admin consent.
- Certificates and secrets: create a client secret. Note its expiry and set a reminder; sign-in stops
  working when it lapses.
- Note the **tenant ID**, **client ID** and **client secret**.

Only people added as members in Scout can sign in, even with a valid Taazaa account.

### 7. Fill in the settings file

Copy `infra/tofu/envs/prod/terraform.tfvars.example` to `terraform.tfvars` in the same folder and fill it in:

| Variable | From |
|---|---|
| `vm_host`, `vm_user`, `ssh_private_key_path` | steps 1 and 2 |
| `cloudflare_api_token`, `cloudflare_account_id`, `cloudflare_zone_id` | step 4 |
| `ghcr_username`, `ghcr_token` | step 5 |
| `azure_ad_tenant_id`, `azure_ad_client_id`, `azure_ad_client_secret` | step 6 (can be left empty at first) |
| `image_tag` | the commit SHA of a green CI run on `scout-rebuild` or `main` |
| `hostname` | `scout` (gives `scout.taazaa.ai`) |

You do **not** create the database passwords, `AUTH_SECRET` or `SCOUT_MASTER_KEY`; OpenTofu generates them.

### 8. Protect the OpenTofu state

The generated secrets live in OpenTofu's state file (`infra/tofu/envs/prod/terraform.tfstate`) on your
laptop. It is git-ignored.

- Back it up somewhere safe (for example the Taazaa password vault or an encrypted drive).
- **Losing the master key means saved integration keys (HubSpot, Apollo, Claude) can't be decrypted**
  and must be entered again.
- Later we can move state to a remote backend (Cloudflare R2 or Azure Storage) if more than one person
  will deploy.

### 9. Run it

```
cd infra/tofu/envs/prod
tofu init
tofu plan      # review together before applying
tofu apply
```

### 10. First run checks

1. `https://scout.taazaa.ai/readyz` returns `{"ok":true}`.
2. Create the Taazaa tenant on the VM:
   ```
   cd /opt/scout
   docker compose -f docker-compose.vm.yml --env-file /opt/scout/.env run --rm background \
     tenants:create --slug taazaa --name Taazaa --currency USD --timezone America/New_York \
     --owner-email zach.wiant@taazaa.com
   ```
3. Sign in with Microsoft as Zach (works once step 6 is done). A non-member should see
   "Your account isn't set up in Scout yet."
4. Admin, System: "Send test event" shows a round trip.
5. Run a backup and the restore check once:
   ```
   docker compose -f docker-compose.vm.yml --env-file /opt/scout/.env run --rm backup /backup.sh
   docker compose -f docker-compose.vm.yml --env-file /opt/scout/.env run --rm backup /restore-check.sh
   ```

## Things to know

- Every compose command on the VM needs `--env-file /opt/scout/.env`.
- `COMPOSE_PROFILES=tunnel` is set in `/opt/scout/.env` so the Cloudflare tunnel container starts.
- Postgres runs on the VM with nightly backups kept 14 days on the VM. Add `BACKUP_REMOTE` and the
  `BACKUP_S3_*` settings later for an off-site copy.
- The worker, relay and scheduler have not yet run inside the container (CI only smoke-tests the web
  role). Watch `docker compose ... logs background` after the first start.
- Rotate the HubSpot token and Apollo key before entering them in Scout (they were pasted in a chat
  earlier, per the v1 handoff notes).

## Open before we start

- [ ] CI image build is green on `scout-rebuild` (a fix was pushed on 2026-10-26).
- [ ] OpenTofu modules written (`infra/tofu/`): Claude, in progress.
- [ ] Steps 1 to 7 above: you.
