# expoflare-updates

Self-hosted Expo over-the-air updates on **your own Cloudflare Worker**. It speaks the [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/), so the `expo-updates` library in your app talks to it the way it talks to EAS Update.

Three pieces, each optional on its own:

- **A handler** you mount in any Worker. It serves manifests and assets, and (with a token) accepts publishes.
- **Storage adapters** for R2 and KV, behind a two-method interface you can implement for anything else.
- **A CLI** that replaces `eas update`: export, upload, switch the channel.

It works with or without [`expoflare`](../expoflare): the handler is a plain `(request, env) => Response`.

## Install

```sh
npm install expoflare-updates
```

## Mount the handler

```ts
// worker.ts
import { createUpdatesHandler, r2Storage } from "expoflare-updates"

const updates = createUpdatesHandler<Env>({
  storage: (env) => r2Storage(env.UPDATES),
  publishToken: (env) => env.UPDATES_TOKEN,
})

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/updates/")) {
      return updates(request, env, ctx)
    }
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
```

```jsonc
// wrangler.jsonc
{
  "r2_buckets": [{ "binding": "UPDATES", "bucket_name": "my-app-updates" }],
}
```

```sh
wrangler r2 bucket create my-app-updates
wrangler secret put UPDATES_TOKEN     # any long random string
```

With Hono: `app.all("/updates/*", (c) => updates(c.req.raw, c.env))`. Next to `expoflare`, call it before `createExpoHandler` in your custom entry.

### Options

| Option           | Default                       | What it does                                                                                      |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `storage`        | required                      | Where updates live: `r2Storage(bucket)`, `kvStorage(namespace)`, or your own.                     |
| `basePath`       | `/updates`                    | The path the handler is mounted at.                                                               |
| `publishToken`   | none                          | Bearer token for publishing. Without it the publish routes don't exist: the handler is read-only. |
| `signingKey`     | none                          | PEM private key for [code signing](#code-signing).                                                |
| `signingKeyId`   | `main`                        | Must match the app's `codeSigningMetadata.keyid`.                                                 |
| `defaultChannel` | `production`                  | The channel for requests that send no `expo-channel-name`.                                        |
| `assetBaseUrl`   | the handler's `/assets` route | Serve assets from elsewhere, e.g. a public R2 domain. Files are at `<assetBaseUrl>/<hash>`.       |

`storage`, `publishToken` and `signingKey` take a value or a function of the Worker's `env`.

### Storage

```ts
r2Storage(env.UPDATES) // recommended
r2Storage(env.FILES, { prefix: "updates/" }) // share a bucket
kvStorage(env.UPDATES_KV) // small bundles only: 25 MiB values, eventually consistent
```

Anything with `get` and `put` works:

```ts
import type { UpdatesStorage } from "expoflare-updates"

const storage: UpdatesStorage = {
  async get(key) {
    /* return { body, contentType } or null */
  },
  async put(key, value, options) {
    /* store value under key with options.contentType */
  },
}
```

What gets written:

| Key                                                    | Contents                                         |
| ------------------------------------------------------ | ------------------------------------------------ |
| `assets/<sha256>`                                      | A bundle or asset. Content-addressed, immutable. |
| `updates/<id>.json`                                    | One record per published update.                 |
| `channels/<channel>/<runtime version>/<platform>.json` | What that channel serves right now.              |

An app launch costs one read (the channel file). Nothing is ever deleted; add an R2 lifecycle rule if you want old bundles to expire.

## Point the app at it

```jsonc
// app.json
{
  "expo": {
    "runtimeVersion": { "policy": "fingerprint" },
    "updates": {
      "url": "https://my-app.example/updates/manifest",
      "requestHeaders": { "expo-channel-name": "production" },
    },
  },
}
```

`updates.url` is compiled into the app, so switching an existing app from EAS Update takes **a new native build**. Builds that already shipped keep asking EAS.

EAS Build sets `expo-channel-name` from the build profile's `channel`; without EAS Build, set it in `requestHeaders` as above. `Updates.setUpdateRequestHeadersOverride({ "expo-channel-name": "preview" })` switches an installed app at runtime.

## Publish

```sh
export EXPOFLARE_UPDATES_URL=https://my-app.example/updates
export EXPOFLARE_UPDATES_TOKEN=...

npx expoflare-updates publish --channel production --platform ios --message "Fix the header"
```

`publish`:

1. Resolves the runtime version from your app config (`npx expo-updates runtimeversion:resolve`, so every policy works, `fingerprint` included). Override with `--runtime-version`.
2. Runs `expo export --platform <platform>`. `EXPO_PUBLIC_*` variables come from your shell and `.env` files, as with any export.
3. Uploads the files the server doesn't have yet.
4. Makes the new update what the channel serves for that runtime version and platform.

An app only gets an update published for **its** runtime version. If the fingerprint changed since the build, the publish succeeds and no installed app takes it: that change needs a new build.

### Roll back

```sh
# Serve an earlier update again (publish prints each id)
npx expoflare-updates rollback --channel production --platform ios --to <update id>

# Send apps back to the bundle embedded in their build
npx expoflare-updates rollback --channel production --platform ios
```

Rolling back to an earlier update republishes its bundle under a new id and time, because the client only takes an update newer than the one it runs.

### CLI

```
expoflare-updates publish  --channel <name> --platform <ios|android|all> [options] [-- <expo export args>]
expoflare-updates rollback --channel <name> --platform <ios|android|all> [--to <update id>] [options]

  --url <url>             Where the handler is mounted (or EXPOFLARE_UPDATES_URL)
  --token <token>         The publish token (or EXPOFLARE_UPDATES_TOKEN)
  --runtime-version <v>   Defaults to what the project's runtimeVersion resolves to
  --message <text>        A note stored with the update
  --root <dir>            Expo project root (default: .)
  --dist <dir>            expo export output directory
  --skip-export           Publish an existing export
```

The same functions are importable: `import { publish, rollback } from "expoflare-updates/publish"`.

## Code signing

Signing lets the app reject any manifest your key didn't sign, so a compromised bucket or domain can't ship code.

```sh
npx expo-updates codesigning:generate \
  --key-output-directory keys --certificate-output-directory certs \
  --certificate-validity-duration-years 10 --certificate-common-name "My App"
npx expo-updates codesigning:configure \
  --certificate-input-directory certs --key-input-directory keys
wrangler secret put UPDATES_SIGNING_KEY < keys/private-key.pem
```

Then pass `signingKey: (env) => env.UPDATES_SIGNING_KEY`. Both PKCS#1 (what `codesigning:generate` writes) and PKCS#8 keys work. The certificate is compiled into the app, so this also takes a new build. Keep `keys/` out of git.

## HTTP routes

Under `basePath`:

| Route                 | Auth  | What it does                                                                                   |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `GET /manifest`       | none  | The Expo Updates endpoint. Reads `expo-platform`, `expo-runtime-version`, `expo-channel-name`. |
| `GET /assets/<hash>`  | none  | A bundle or asset, cached forever.                                                             |
| `HEAD /assets/<hash>` | none  | Whether the file is there.                                                                     |
| `PUT /assets/<hash>`  | token | Uploads a file. Rejected unless its SHA-256 is `<hash>`.                                       |
| `POST /updates`       | token | Publishes an update and switches the channel to it.                                            |
| `POST /rollback`      | token | Rolls a channel back to an earlier update or to the embedded bundle.                           |

## vs. EAS Update

EAS Update gives you the dashboard, gradual rollouts, update groups across platforms, and `fingerprint:compare` against a build, with nothing to run. Use expoflare-updates if you want updates in your own account next to the Worker that serves your API, deployed and paid for the same way.

Not here yet: gradual rollouts, a list of past updates in the CLI, asset cleanup.

## Limitations

- An upload passes through the Worker, so one file is capped by the Workers request body limit (100 MB on the free and Pro plans).
- Builds and store submissions are a separate job: this only replaces `eas update`.

## License

MIT
