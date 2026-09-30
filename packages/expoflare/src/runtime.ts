import { createRequestHandler } from "expo-server/adapter/workerd"

export type ExpoHandler<Env = unknown> = ReturnType<
  typeof createRequestHandler<Env>
>

export interface ExpoHandlerOptions {
  /** Exposed to server code through `expo-server`'s `environment()`. */
  environment?: string | null
}

/**
 * Creates the Expo request handler for a Worker built by `expoflare build`.
 *
 * The handler loads `routes.json`, pre-rendered HTML, and API route modules
 * with dynamic `import()`. `expoflare build` uploads those files as modules
 * next to the Worker entry, so they resolve relative to it. That is why this
 * only works inside the bundle that `expoflare build` produces.
 */
export function createExpoHandler<Env = unknown>(
  options: ExpoHandlerOptions = {}
): ExpoHandler<Env> {
  return createRequestHandler<Env>({
    build: ".",
    environment: options.environment ?? null,
  })
}
