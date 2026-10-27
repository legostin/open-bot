# owlbot-tailnet

The Owlbot hub's own Tailscale node, for access from anywhere (`packages/core/src/remote.ts`). It is a small Go
program on [tsnet](https://pkg.go.dev/tailscale.com/tsnet): the hub starts it, and it joins the user's tailnet as
`owlbot` and serves the permanent link `https://owlbot.<tailnet>.ts.net` through Tailscale Funnel.

- `:443` (Tailscale's certificate) → the hub's web gateway, `:8443` (the hub's own device certificate, which phones
  pin) → the hub's phone gateway. Both are plain HTTP proxies to loopback ports with the client's address in
  `X-Forwarded-For`.
- The hub talks to it in JSON lines. stdin: `{"type":"start", "dir", "hostname", "web", "device", "deviceCert",
  "deviceKey"}`, then `{"type":"logout"}`; closing stdin stops it. stdout: `{"type":"state", "state": "starting" |
  "needs-login" | "needs-funnel" | "running" | "error", "authUrl", "enableUrl", "url", "deviceUrl", "account",
  "keyExpiry", "message"}`. stderr is its log.
- Its keys live in `dir` (`<data>/tailnet`). It does not send Tailscale its logs.

Build: `npm run build:tailnet` from the repository root (this computer), `-- --all` for every platform Owlbot ships,
into `bin/<platform>-<arch>/`. Tests: `go test ./...` here. Go fetches the toolchain version `go.mod` asks for.
