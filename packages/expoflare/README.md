# expoflare

Deploy an Expo web app to **your own Cloudflare account**: static sites, single-page apps, or Expo Router with API routes and server rendering.

```sh
npx @thecomputerplumbers/expoflare build   # expo export -p web, then package for Workers
npx wrangler deploy   # or: wrangler dev
```

expoflare doesn't reimplement Expo's server. Server output runs on [`expo-server`](https://docs.expo.dev/versions/latest/sdk/server/)'s official `workerd` adapter, the same runtime [EAS Hosting](https://docs.expo.dev/eas/hosting/introduction/) uses. API routes, middleware, loaders, redirects, rewrites, and SSR behave as Expo documents them. expoflare packages the export for Workers and leaves Expo's runtime alone.

## Install

```sh
npm install -D @thecomputerplumbers/expoflare wrangler
npx expo install expo-server   # only for "web.output": "server"
```

## Output modes

expoflare reads the shape of `expo export -p web` and picks a deployment to match. Set the mode with `web.output` in `app.json`:

| `web.output` | What deploys                                       | Unmatched paths                         |
| ------------ | -------------------------------------------------- | --------------------------------------- |
| `single`     | Assets-only Worker                                 | `index.html` (SPA fallback)             |
| `static`     | Assets-only Worker, one HTML file per route        | `+not-found.html`, served as `404.html` |
| `server`     | Worker running `expo-server`, with assets in front | Expo's not-found route                  |

Assets-only Workers run no code on requests. On Cloudflare, static asset requests are free and don't count toward Worker request limits.

## How it works

`expoflare build`:

1. Runs `expo export --platform web` (skip it with `--skip-export`).
2. Copies the client output to `.expoflare/assets`. It adds a long-lived `Cache-Control` for the content-hashed `/_expo/static/*` files, unless you ship your own `_headers`.
3. For server output, copies `dist/server` to `.expoflare/worker` and writes an entry that calls `expo-server`. API routes, `routes.json`, and pre-rendered HTML are uploaded as Worker modules, because `expo-server` loads them with dynamic `import()`.
4. Writes `.expoflare/wrangler.json` from your `wrangler.jsonc`, keeping your bindings, vars, routes, and environments.
5. Writes `.wrangler/deploy/config.json`, which tells wrangler to use the generated config. This is the same mechanism the Cloudflare Vite plugin uses, so plain `wrangler dev`, `wrangler deploy`, and `wrangler versions upload` work unchanged.

If there's no `wrangler.jsonc`, the first build creates one. It's yours to edit from then on.

Add `.expoflare/` and `.wrangler/` to `.gitignore`.

## Bindings, Durable Objects, cron: a custom entry

Set `main` in `wrangler.jsonc` to your own Worker. Call `createExpoHandler` for requests Expo should handle:

```ts
// worker.ts
import { createExpoHandler } from "@thecomputerplumbers/expoflare/runtime"

const expo = createExpoHandler<Env>()

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok")
    return expo(request, env, ctx)
  },
  async scheduled(controller, env, ctx) {
    // ...
  },
} satisfies ExportedHandler<Env>

export { MyDurableObject } from "./durable-object"
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "worker.ts",
  "compatibility_date": "2026-09-30",
  "kv_namespaces": [{ "binding": "CACHE", "id": "..." }],
}
```

With server output, expoflare re-exports your entry from `.expoflare/worker/index.js`, so named exports like Durable Object classes keep working. With static output, your entry is used directly and `assets` is served in front of it.

## CLI

```
expoflare build [--root <dir>] [--dist <dir>] [--skip-export] [-- <expo export args>]
```

## vs. EAS Hosting

EAS Hosting runs the same `expo-server` runtime on Cloudflare, managed by Expo. Use it if you want `eas deploy`, the Expo dashboard, and no Cloudflare account to manage. Use expoflare if you want the Worker in your own account, on your plan, next to your KV, D1, R2, Durable Objects, and queues, deployed with the wrangler pipeline you already have.

## Limitations

- Reads `wrangler.jsonc` or `wrangler.json`. TOML isn't supported yet.
- API routes are bundled by Metro, which doesn't resolve `cloudflare:*` imports. To use bindings, handle those requests in a custom entry for now.

## License

MIT
