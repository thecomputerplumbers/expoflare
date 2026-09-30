# expoflare

Deploy Expo web exports (static, single-page, or server with API routes) to your own Cloudflare Workers account. It runs on the same `expo-server` runtime as EAS Hosting.

Docs: [packages/expoflare/README.md](packages/expoflare/README.md)

## Repo layout

- `packages/expoflare`: the published package (the `expoflare` CLI and `expoflare/runtime`)
- `examples/basic`: an Expo Router app with server output, pages, and API routes
- `scripts/e2e.mjs`: builds the example and tests it under `wrangler dev`

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
