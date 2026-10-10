import {
  createUpdatesHandler,
  r2Storage,
  type R2BucketLike,
} from "expoflare-updates"

interface Env {
  UPDATES: R2BucketLike
  UPDATES_TOKEN?: string
  UPDATES_SIGNING_KEY?: string
}

// The app's `updates.url` is https://<this worker>/updates/manifest.
const updates = createUpdatesHandler<Env>({
  storage: (env) => r2Storage(env.UPDATES),
  publishToken: (env) => env.UPDATES_TOKEN,
  signingKey: (env) => env.UPDATES_SIGNING_KEY,
})

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/updates/")) {
      return updates(request, env)
    }
    return new Response("Not found", { status: 404 })
  },
}
