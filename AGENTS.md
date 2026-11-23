# lan-drop - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads.

## Rules

1. **Two ways in, one rule: only the same local network.** The service binds every interface (`LANDROP_HOST`, default `0.0.0.0`) so phones on the Wi-Fi reach it at `http://<lan ip>:<port>/` without the space's router; a direct request from a non-private address is refused (`src/net.ts`). It is also reachable through the space's router at its domain, behind the space's login, so a signed-in user can open it from any device. Devices see and send only to devices on their own network (`networkOf`): a direct LAN connection is `home`; through the router, the device's `Cf-Connecting-IP` (trusted only when the TCP peer is loopback) is its network, and the host's own egress addresses (`egressKeys`, refreshed every ten minutes, plus `LANDROP_HOME_IPS`) count as `home`. IPv6 groups by /64. The page itself is static and served to anyone who reaches the port.
2. **The receiver decides.** Nothing is uploaded before the receiver accepts the offer. Only the receiver gets the download keys (`TransferView.files[].url`); the sender never sees them.
3. **Bytes are not kept.** Uploads go to `<data dir>/spool/`, emptied at every start. A transfer's files are removed an hour after it ends, at once when it is cancelled. Unanswered offers expire after ten minutes. The room itself (peers, transfers) lives in memory: a restart forgets it, and pages reconnect and rejoin.
4. **Pieces.** Uploads go in pieces of 64 MB (`PIECE` in `web/client.ts`) with `?offset=`, because a Cloudflare tunnel refuses a request body over 100 MB. A piece must start where the file ends; offset 0 starts the file over.
5. **Peer credentials.** Each page keeps a random id and secret in `localStorage`; the socket's `hello` and every upload (`x-peer-id`, `x-peer-secret`) carry them. A known id with the wrong secret is refused. With `LANDROP_PIN` set, devices on the direct LAN port (not loopback, so not the signed-in router path) must send the PIN in `hello`; five wrong tries lock that address out for a minute.
6. **One LAN port.** The git deployment runs on PORT 9110, its LAN port. An installed package gets a new loopback PORT from ai-space at every start, for the space's gateway only; the service then binds that one to 127.0.0.1 and listens on every interface at `LANDROP_LAN_PORT` (default 9110) as well, one app behind both, so the address in the QR code survives a restart (`src/index.ts`).
7. **Portable.** No hostname, IP, ssh alias or home directory in code or the manifest. The join address comes from the machine's interfaces (`lanAddresses`, skipping docker/bridge/VPN interfaces) or `LANDROP_PUBLIC_URL`.
8. **Same origin.** The socket and uploads refuse another site's `Origin`, so a web page elsewhere on the LAN cannot drive a device's session. The one exception is the direct path below: the origins in `LANDROP_PAGE_ORIGINS` may use the file-byte routes (`BYTE_ROUTE` in `src/server.ts`) cross-origin, never the socket.
9. **Direct path.** An https page through the router cannot reach a plain-http LAN address (mixed content), so with `LANDROP_TLS_PORT`, `LANDROP_TLS_CERT`, `LANDROP_TLS_KEY` and `LANDROP_DIRECT_URL` the same app also listens with TLS for a name that resolves to the LAN address. `/api/info` through the router gives the page that URL and an instance id; the page pings it in the background and, when the instance matches, sends uploads and downloads there while the socket stays on the router. A failed piece falls back to the router. The certificate is read again every six hours, so a renewal needs no restart.

## How it works

```
page ─ws /api/ws─▶ Room (src/room.ts): peers, offers, transfers, text
  │                     ▲ progress, done, failed
  └─PUT /api/transfers/:id/files/:i ─▶ Spool (src/spool.ts) → <data>/spool/<id>-<i>
receiver ─GET /api/download/:key/:name─▶ the spooled file, as an attachment
```

Socket messages (JSON): page → server `hello`, `rename`, `offer {ref,to,files}`, `respond {id,accept}`, `cancel {id}`, `text {to,text}`, `ping`; server → page `welcome`, `peers`, `transfer`, `text`, `offered {ref,id}`, `error {code,ref}`, `replaced` (the same device opened another tab).

## Directory map

```
space.yaml          manifest: identity, service on port 9110, deploy checks (the git deployment, spec 1)
space.release.yaml  the installation package's manifest (spec 2): launch dist/index.js in background
src/index.ts        boot: Bun.serve on every interface, page route, sweep timer
src/server.ts       HTTP + WebSocket handlers, PIN gate, uploads, downloads
src/room.ts         the room state (pure, tested)
src/spool.ts        upload bytes on disk, exact-length check, free-space check
src/net.ts          private-address check, LAN addresses and join URLs
web/index.html      the page (designed in Design Studio); web/app.ts the UI; web/styles.css
web/client.ts       socket with reconnect, upload with progress (XHR)
web/device.ts       identity, friendly names, device kind, byte and time formats
web/i18n.ts         zh / en strings
deploy/post-receive bare-repository hook: `space app deploy`
scripts/pack.ts     `bun run pack`: the .spaceapp packages through `space app release`
src/release.test.ts space.release.yaml carries space.yaml's components
.github/workflows/release.yml  a v<version> tag builds, signs and publishes the packages
```

## Commands

```bash
bun install
PORT=9110 bun src/index.ts
bun run check            # install, typecheck, tests
bun run build            # dist/: the bundle the package runs
bun run pack             # the packages (needs ai-space's CLI: SPACE_CLI or `space` on PATH)
```

## Deployment

- Runs on the space of the machine that sits on the home network (it must share the Wi-Fi with the devices).
- Deploy: `git push deploy main` to the bare repository `~/lan-drop.git` on that host; its `post-receive` hook (`deploy/post-receive`) runs `space app deploy lan-drop` (checkout, `bun install --frozen-lockfile`, typecheck, tests, restart only when they pass).
- Source: GitHub `ericz-lab/lan-drop` (public, MIT, remote `origin`). After a deploy, `git push origin main`.
- A new app's first deploy also needs `space app sync` on that host, which registers the directory.
- Keep `bun.lock` at `"lockfileVersion": 1` while a host runs Bun 1.3.
- The port (9110) must be open on the host's firewall for the LAN.

## Release (the app catalog)

The app is listed in [ai-space-apps](https://github.com/ericz-lab/ai-space-apps). Raise `version` in `space.release.yaml` and `package.json`, merge, tag `v<version>`: the release workflow builds, signs with the `SPACE_SIGN_KEY` secret and attaches `lan-drop-<version>.spaceapp` and `-source.spaceapp` to the GitHub release. Then the catalog's `store-release` workflow copies them to the store and opens the pull request that points `apps/lan-drop.json` at them.

## Known pitfalls

- Over plain `http://<lan ip>` the page is not a secure context: no `navigator.clipboard` (copy falls back to a selected text field + `execCommand`), no `crypto.randomUUID` (ids use `getRandomValues`).
- The usage and feedback scripts load from `/_space/*`, which only exists through the space's router; on the direct LAN address they 404 and that is harmless.
- iOS Safari saves a download through its own sheet; the page opens each received file's link on a tap, never automatically for more than one file.
