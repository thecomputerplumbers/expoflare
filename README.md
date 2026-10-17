# expoflare

Deploy Expo web exports (static, single-page, or server with API routes) to your own Cloudflare Workers account. It runs on the same `expo-server` runtime as EAS Hosting.

Install: `npm install -D @thecomputerplumbers/expoflare wrangler`

Docs: [packages/expoflare/README.md](packages/expoflare/README.md)

## Repo layout

- `packages/expoflare`: the published package (the `expoflare` CLI and `@thecomputerplumbers/expoflare/runtime`)
- `packages/expoflare-updates`: self-hosted Expo over-the-air updates (a mountable handler, R2/KV storage, a publish CLI). Docs: [packages/expoflare-updates/README.md](packages/expoflare-updates/README.md)
- `examples/basic`: an Expo Router app with server output, pages, and API routes
- `examples/updates`: a Worker that serves updates from R2
- `scripts/e2e.mjs`: builds the example and tests it under `wrangler dev`
- `scripts/e2e-updates.mjs`: publishes an iOS export of `examples/basic` to `examples/updates` under `wrangler dev` and reads it back

## Develop

```sh
mise run setup
mise run check      # lint, format, typecheck, build, unit tests
pnpm test:e2e       # real expo export + wrangler dev
```

Try the example against your own account:

```sh
cd examples/basic
pnpm preview        # expoflare build && wrangler dev
pnpm run deploy     # expoflare build && wrangler deploy
```
