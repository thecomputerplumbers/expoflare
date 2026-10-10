import {
  ASSET_HASH,
  PLATFORMS,
  assetKey,
  channelKey,
  manifestBody,
  multipartResponse,
  protocolHeaders,
  updateKey,
  type AssetRecord,
  type ChannelPointer,
  type MultipartPart,
  type Platform,
  type UpdateRecord,
} from "./protocol.ts"
import { signatureHeader, toBase64Url } from "./signing.ts"
import type { UpdatesStorage } from "./storage.ts"

/** A value, or a function that reads it from the Worker's `env`. */
export type FromEnv<T, Env> = T | ((env: Env) => T)

export interface UpdatesHandlerOptions<Env = unknown> {
  /** Where updates are kept, e.g. `(env) => r2Storage(env.UPDATES)`. */
  storage: FromEnv<UpdatesStorage, Env>
  /** The path the handler is mounted at. Defaults to `/updates`. */
  basePath?: string
  /**
   * Bearer token for publishing. Without it the publish routes don't exist
   * and the handler only serves manifests and assets.
   */
  publishToken?: FromEnv<string | undefined, Env>
  /**
   * PEM private key for Expo code signing. When set, manifests and directives
   * are signed for apps built with `updates.codeSigningCertificate`.
   */
  signingKey?: FromEnv<string | undefined, Env>
  /** Must match `updates.codeSigningMetadata.keyid`. Defaults to `main`. */
  signingKeyId?: string
  /** The channel for requests without `expo-channel-name`. Defaults to `production`. */
  defaultChannel?: string
  /**
   * Serve assets from somewhere else, e.g. a public R2 domain whose paths are
   * `<assetBaseUrl>/<hash>`. Defaults to this handler's `/assets` route.
   */
  assetBaseUrl?: string
}

export type UpdatesHandler<Env = unknown> = (
  request: Request,
  env: Env,
  ctx?: unknown
) => Promise<Response>

interface Context {
  request: Request
  url: URL
  storage: UpdatesStorage
  basePath: string
  publishToken: string | undefined
  signingKey: string | undefined
  signingKeyId: string
  defaultChannel: string
  assetBaseUrl: string
}

/**
 * Creates a request handler for the Expo Updates protocol. Mount it at
 * `basePath` in any Worker and point the app's `updates.url` at
 * `https://<host><basePath>/manifest`.
 */
export function createUpdatesHandler<Env = unknown>(
  options: UpdatesHandlerOptions<Env>
): UpdatesHandler<Env> {
  const basePath = (options.basePath ?? "/updates").replace(/\/+$/, "")

  return async (request, env) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${basePath}/`)) return error(404, "Not found")
    const route = url.pathname.slice(basePath.length + 1)

    const cx: Context = {
      request,
      url,
      storage: fromEnv(options.storage, env),
      basePath,
      publishToken: fromEnv(options.publishToken, env) || undefined,
      signingKey: fromEnv(options.signingKey, env) || undefined,
      signingKeyId: options.signingKeyId ?? "main",
      defaultChannel: options.defaultChannel ?? "production",
      assetBaseUrl: (
        options.assetBaseUrl ?? `${url.origin}${basePath}/assets`
      ).replace(/\/+$/, ""),
    }

    try {
      return await dispatch(route, cx)
    } catch (thrown) {
      // Request errors are thrown as responses; anything else is a bug.
      if (thrown instanceof Response) return thrown
      throw thrown
    }
  }
}

async function dispatch(route: string, cx: Context): Promise<Response> {
  const method = cx.request.method

  if (route === "manifest" && method === "GET") return serveManifest(cx)

  if (route.startsWith("assets/")) {
    const hash = route.slice("assets/".length)
    if (!ASSET_HASH.test(hash)) throw error(404, "Not found")
    if (method === "GET") return serveAsset(hash, cx)
    if (method === "HEAD") {
      const exists = await hasObject(cx.storage, assetKey(hash))
      return new Response(null, { status: exists ? 200 : 404 })
    }
    if (method === "PUT" && cx.publishToken) {
      await authorize(cx)
      return uploadAsset(hash, cx)
    }
  }

  if (method === "POST" && cx.publishToken) {
    if (route === "updates") {
      await authorize(cx)
      return publishUpdate(cx)
    }
    if (route === "rollback") {
      await authorize(cx)
      return rollBack(cx)
    }
  }

  throw error(404, "Not found")
}

async function serveManifest(cx: Context): Promise<Response> {
  const { request, url } = cx
  const protocolVersion =
    request.headers.get("expo-protocol-version") === "1" ? 1 : 0
  const platform = parsePlatform(
    request.headers.get("expo-platform") ?? url.searchParams.get("platform")
  )
  const runtimeVersion = parseName(
    request.headers.get("expo-runtime-version") ??
      url.searchParams.get("runtime-version"),
    "runtime version"
  )
  const channel = parseName(
    request.headers.get("expo-channel-name") ??
      url.searchParams.get("channel") ??
      cx.defaultChannel,
    "channel"
  )

  const pointer = await readJson<ChannelPointer>(
    cx.storage,
    channelKey(channel, runtimeVersion, platform)
  )
  if (!pointer) return nothingToServe(protocolVersion)

  const currentId = request.headers.get("expo-current-update-id")

  if (pointer.type === "rollBackToEmbedded") {
    // Directives are protocol v1 only.
    if (protocolVersion === 0) return nothingToServe(protocolVersion)
    const embeddedId = request.headers.get("expo-embedded-update-id")
    const directive =
      embeddedId && embeddedId === currentId
        ? { type: "noUpdateAvailable" }
        : {
            type: "rollBackToEmbedded",
            parameters: { commitTime: pointer.commitTime },
          }
    return multipartResponse(
      [await signed("directive", JSON.stringify(directive), cx)],
      protocolVersion
    )
  }

  if (protocolVersion === 1 && currentId === pointer.update.id) {
    return multipartResponse(
      [
        await signed(
          "directive",
          JSON.stringify({ type: "noUpdateAvailable" }),
          cx
        ),
      ],
      protocolVersion
    )
  }

  const manifest = JSON.stringify(manifestBody(pointer.update, cx.assetBaseUrl))
  return multipartResponse(
    [
      await signed("manifest", manifest, cx),
      { name: "extensions", body: JSON.stringify({ assetRequestHeaders: {} }) },
    ],
    protocolVersion
  )
}

/** v1 clients take a 204 as "no update"; v0 clients expect a manifest or an error. */
function nothingToServe(protocolVersion: number): Response {
  if (protocolVersion === 0) {
    return error(404, "No update is published for this runtime version.")
  }
  return new Response(null, {
    status: 204,
    headers: protocolHeaders(protocolVersion),
  })
}

async function signed(
  name: string,
  body: string,
  cx: Context
): Promise<MultipartPart> {
  if (!cx.signingKey) {
    if (cx.request.headers.get("expo-expect-signature")) {
      throw error(
        400,
        "This app expects signed manifests, but no signingKey is configured."
      )
    }
    return { name, body }
  }
  return {
    name,
    body,
    signature: await signatureHeader(body, cx.signingKey, cx.signingKeyId),
  }
}

async function serveAsset(hash: string, cx: Context): Promise<Response> {
  const object = await cx.storage.get(assetKey(hash))
  if (!object) throw error(404, "Not found")
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType ?? "application/octet-stream",
      // Content-addressed, so it never changes.
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
}

async function uploadAsset(hash: string, cx: Context): Promise<Response> {
  const body = await cx.request.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", body)
  if (toBase64Url(new Uint8Array(digest)) !== hash) {
    throw error(400, "The body's SHA-256 doesn't match the asset hash.")
  }
  await cx.storage.put(assetKey(hash), body, {
    contentType:
      cx.request.headers.get("content-type") ?? "application/octet-stream",
  })
  return json(201, { hash })
}

async function publishUpdate(cx: Context): Promise<Response> {
  const input = await readBody(cx.request)
  const runtimeVersion = parseName(input.runtimeVersion, "runtime version")
  const platform = parsePlatform(input.platform)
  const channel = parseName(input.channel, "channel")
  const update: UpdateRecord = {
    id: crypto.randomUUID(),
    createdAt: await nextCommitTime(cx, channel, runtimeVersion, platform),
    runtimeVersion,
    platform,
    channel,
    message: typeof input.message === "string" ? input.message : undefined,
    launchAsset: parseAsset(input.launchAsset),
    assets: Array.isArray(input.assets) ? input.assets.map(parseAsset) : [],
    metadata: isRecord(input.metadata)
      ? Object.fromEntries(
          Object.entries(input.metadata).map(([k, v]) => [k, String(v)])
        )
      : {},
    extra: isRecord(input.extra) ? input.extra : {},
  }
  await serve(update, cx)
  return json(201, { update })
}

async function rollBack(cx: Context): Promise<Response> {
  const input = await readBody(cx.request)
  const channel = parseName(input.channel, "channel")
  const runtimeVersion = parseName(input.runtimeVersion, "runtime version")
  const platform = parsePlatform(input.platform)

  const commitTime = await nextCommitTime(cx, channel, runtimeVersion, platform)

  if (input.updateId === undefined) {
    const pointer: ChannelPointer = { type: "rollBackToEmbedded", commitTime }
    await writeJson(
      cx.storage,
      channelKey(channel, runtimeVersion, platform),
      pointer
    )
    return json(201, { directive: pointer })
  }

  if (typeof input.updateId !== "string" || !/^[\w-]+$/.test(input.updateId)) {
    throw error(400, "updateId must be an update id.")
  }
  const previous = await readJson<UpdateRecord>(
    cx.storage,
    updateKey(input.updateId)
  )
  if (!previous) throw error(404, `Update ${input.updateId} doesn't exist.`)
  if (
    previous.runtimeVersion !== runtimeVersion ||
    previous.platform !== platform
  ) {
    throw error(
      409,
      `Update ${previous.id} was built for ${previous.platform} runtime ${previous.runtimeVersion}.`
    )
  }
  // The client only takes an update newer than the one it runs, so going
  // back means serving the old bundle as a new update.
  const update: UpdateRecord = {
    ...previous,
    id: crypto.randomUUID(),
    createdAt: commitTime,
    channel,
    message: `Republish of ${previous.id}`,
  }
  await serve(update, cx)
  return json(201, { update })
}

/** Records the update, then makes it what its channel serves. */
async function serve(update: UpdateRecord, cx: Context) {
  await writeJson(cx.storage, updateKey(update.id), update)
  const pointer: ChannelPointer = { type: "update", update }
  await writeJson(
    cx.storage,
    channelKey(update.channel, update.runtimeVersion, update.platform),
    pointer
  )
}

/**
 * The time for whatever the channel serves next. The client only acts on
 * something newer than what it has, so this is always later than the time of
 * what the channel serves now, even within the same millisecond.
 */
async function nextCommitTime(
  cx: Context,
  channel: string,
  runtimeVersion: string,
  platform: Platform
): Promise<string> {
  const current = await readJson<ChannelPointer>(
    cx.storage,
    channelKey(channel, runtimeVersion, platform)
  )
  const served = !current
    ? 0
    : Date.parse(
        current.type === "update"
          ? current.update.createdAt
          : current.commitTime
      )
  return new Date(Math.max(Date.now(), served + 1)).toISOString()
}

async function authorize(cx: Context) {
  const header = cx.request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (!cx.publishToken || !(await sameSecret(token, cx.publishToken))) {
    throw error(401, "Missing or wrong publish token.")
  }
}

/** Compares digests so the time taken doesn't depend on where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ])
  const left = new Uint8Array(x)
  const right = new Uint8Array(y)
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!
  return difference === 0
}

function parsePlatform(value: unknown): Platform {
  const platform = PLATFORMS.find((candidate) => candidate === value)
  if (!platform) throw error(400, "platform must be ios or android.")
  return platform
}

function parseName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw error(400, `Missing or invalid ${label}.`)
  }
  return value
}

function parseAsset(value: unknown): AssetRecord {
  if (
    !isRecord(value) ||
    typeof value.hash !== "string" ||
    !ASSET_HASH.test(value.hash) ||
    typeof value.key !== "string" ||
    typeof value.contentType !== "string"
  ) {
    throw error(400, "Each asset needs a hash, key and contentType.")
  }
  return {
    hash: value.hash,
    key: value.key,
    contentType: value.contentType,
    fileExtension:
      typeof value.fileExtension === "string" ? value.fileExtension : undefined,
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw error(400, "The body must be JSON.")
  }
  if (!isRecord(body)) throw error(400, "The body must be a JSON object.")
  return body
}

async function readJson<T>(
  storage: UpdatesStorage,
  key: string
): Promise<T | null> {
  const object = await storage.get(key)
  if (!object) return null
  return (await new Response(object.body).json()) as T
}

async function writeJson(storage: UpdatesStorage, key: string, value: unknown) {
  await storage.put(key, JSON.stringify(value), {
    contentType: "application/json",
  })
}

async function hasObject(
  storage: UpdatesStorage,
  key: string
): Promise<boolean> {
  if (storage.has) return storage.has(key)
  const object = await storage.get(key)
  if (object && object.body instanceof ReadableStream) {
    await object.body.cancel()
  }
  return object !== null
}

function fromEnv<T, Env>(value: FromEnv<T, Env>, env: Env): T {
  return typeof value === "function" ? (value as (env: Env) => T)(env) : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function error(status: number, message: string): Response {
  return json(status, { error: message })
}
