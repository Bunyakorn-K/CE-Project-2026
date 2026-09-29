# Internal registry (`/srv/registry`)

The internal Docker registry v2 that the app deploy path pushes to and pulls
from. It is a **deploy dependency**, not an analytics service, so it has its
own compose file and its own install directory.

| File | Installed to | Secret? |
|---|---|---|
| `config.yml` | `${registry_dir}/config.yml` | no — committed here |
| `htpasswd` | `${registry_dir}/htpasswd` | **yes** — rendered by `tofu`, never committed |

## Why auth is mandatory

`registry:2` with no `auth` block accepts anonymous **push and pull**. Anything
that can reach port 5000 can overwrite `laundrytwin-api`, `laundrytwin-web`,
`laundrytwin-etl` and `laundrytwin-weather`, and the next
`docker compose pull` in `deploy/tofu/stacks.tf` deploys the attacker's image.
`config.yml` therefore carries an `auth.htpasswd` block, and the smoke check in
`deploy/tofu/stacks.tf` asserts an anonymous request to `/v2/` answers **401** —
so removing auth fails the apply instead of silently widening the registry.

`deploy/registry/compose.yaml` publishes `0.0.0.0:5000` on purpose: the deploy
host pulls by its own address (`10.10.0.117:5000`), so binding to `127.0.0.1`
would break every pull. There is **no TLS** in here — the credential crosses
the trusted network (ZeroTier / LAN) in cleartext, and the Mac pushes through
the Pi's Caddy route. Treat port 5000 as trusted-network-only.

## Supplying the credential

`registry_htpasswd_entry` takes a **pre-hashed** `user:hash` line, not a
plaintext password. Two reasons: OpenTofu would otherwise hold the plaintext in
state, and generating the hash inside a `local-exec` would put the password on
a command line.

```bash
# on the host that will deploy — prompts, nothing lands in shell history
docker run --rm httpd:2-alpine htpasswd -nB laundrytwin
# -> laundrytwin:$2y$05$....  put that whole line in terraform.tfvars

# record it for the daemon that pulls images
sudo docker login 10.10.0.117:5000 -u laundrytwin   # prompts for the password
```

`deploy/tofu` refuses to install an empty `registry_htpasswd_entry`: the
provisioner fails rather than writing an empty htpasswd and leaving the
registry wide open.

## Starting it

`tofu` installs the **files** only. It does not start or recreate the registry
container, because doing so would interrupt a running deploy path. On the host:

```bash
cd /srv/registry
sudo docker compose -f /opt/laundrytwin/deploy/registry/compose.yaml up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/v2/   # 401
```

## Rotating

Generate a new entry, update `registry_htpasswd_entry` in `terraform.tfvars`,
`sudo docker login` again, then apply. Existing `docker login` sessions keep
working until their token expires; there is no forced logout, so rotate on a
maintenance window if that matters to you.
