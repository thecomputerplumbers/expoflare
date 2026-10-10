# expoflare

expoflare packages `expo export -p web` output for Cloudflare Workers. It does not implement request handling. Server output runs on `expo-server/adapter/workerd` (the EAS Hosting runtime). Keep it that way: fix behavior differences by changing how the export is packaged, not by forking Expo's router logic.

## Invariants

- `expo-server` resolves routes, HTML, and API modules with dynamic `import()` relative to the Worker entry. The generated entry must sit at the root of `.expoflare/worker` (the wrangler `base_dir`), and those files are uploaded as additional modules through `rules`. Metro emits API routes as CommonJS.
- wrangler finds the generated config through `.wrangler/deploy/config.json` (redirected config). Paths in the user's config are relative to their file and must be rebased when copied into `.expoflare/wrangler.json`. See `rebasePaths`.
- The user owns `wrangler.jsonc`. expoflare creates it only when it's missing and never rewrites it.

## expoflare-updates

`packages/expoflare-updates` is separate from `expoflare` and neither depends on the other. It implements the Expo Updates protocol (v0 and v1) for the `expo-updates` client.

- `src/index.ts` and what it imports run in a Worker: web APIs only, no `node:` imports, no dependencies. Node code (`publish.ts`, `cli.ts`) is reached through `expoflare-updates/publish` and the bin.
- The client only acts on an update or directive newer than what it has. Anything a channel serves gets a new id and a later time, republished updates included (`nextCommitTime`).
- A signature covers the exact bytes of its multipart part. Sign the string that is sent; never re-serialize after signing.
- Storage keys (`assets/`, `updates/`, `channels/`) are a format deployed buckets already hold. Add keys; don't rename them.

## Checks

`mise run check` runs the unit tests. Anything that changes the build output or the runtime also needs `pnpm test:e2e`, which runs a real `expo export` and `wrangler dev`, for both packages.
