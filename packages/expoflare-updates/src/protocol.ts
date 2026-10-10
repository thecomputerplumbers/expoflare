// The Expo Updates protocol, v0 and v1:
// https://docs.expo.dev/technical-specs/expo-updates-1/

export type Platform = "ios" | "android"

export const PLATFORMS: readonly Platform[] = ["ios", "android"]

/** A bundle or asset, stored at `assets/<hash>`. */
export interface AssetRecord {
  /** Base64url SHA-256 of the file. The client verifies it. */
  hash: string
  /** The client's cache key for the file. */
  key: string
  contentType: string
  fileExtension?: string
}

/** A published update, stored at `updates/<id>.json`. */
export interface UpdateRecord {
  id: string
  createdAt: string
  runtimeVersion: string
  platform: Platform
  channel: string
  message?: string
  launchAsset: AssetRecord
  assets: AssetRecord[]
  metadata: Record<string, string>
  /** The manifest's `extra`, usually `{ expoClient: <expo config> }`. */
  extra: Record<string, unknown>
}

/** What a channel serves for one runtime version and platform. */
export type ChannelPointer =
  | { type: "update"; update: UpdateRecord }
  | { type: "rollBackToEmbedded"; commitTime: string }

export function channelKey(
  channel: string,
  runtimeVersion: string,
  platform: Platform
): string {
  return `channels/${encodeURIComponent(channel)}/${encodeURIComponent(runtimeVersion)}/${platform}.json`
}

export const updateKey = (id: string) => `updates/${id}.json`
export const assetKey = (hash: string) => `assets/${hash}`

/** Base64url SHA-256, unpadded: 43 characters. */
export const ASSET_HASH = /^[A-Za-z0-9_-]{43}$/

/** The manifest body the client reads, with absolute asset URLs. */
export function manifestBody(update: UpdateRecord, assetBaseUrl: string) {
  const withUrl = (asset: AssetRecord) => ({
    ...asset,
    url: `${assetBaseUrl}/${asset.hash}`,
  })
  return {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: withUrl(update.launchAsset),
    assets: update.assets.map(withUrl),
    metadata: update.metadata,
    extra: update.extra,
  }
}

export interface MultipartPart {
  name: string
  body: string
  /** Value for the part's `expo-signature` header. */
  signature?: string
}

/** A `multipart/mixed` response in the shape expo-updates parses. */
export function multipartResponse(
  parts: MultipartPart[],
  protocolVersion: number
): Response {
  const boundary = `expoflare-${crypto.randomUUID()}`
  let body = ""
  for (const part of parts) {
    body += `--${boundary}\r\n`
    body += `content-disposition: form-data; name="${part.name}"\r\n`
    body += "content-type: application/json; charset=utf-8\r\n"
    if (part.signature) body += `expo-signature: ${part.signature}\r\n`
    body += `\r\n${part.body}\r\n`
  }
  body += `--${boundary}--\r\n`
  return new Response(body, {
    headers: {
      ...protocolHeaders(protocolVersion),
      "content-type": `multipart/mixed; boundary=${boundary}`,
    },
  })
}

export function protocolHeaders(protocolVersion: number) {
  return {
    "expo-protocol-version": String(protocolVersion),
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0",
  }
}
