/** What a storage backend hands back for a key. */
export interface StoredObject {
  body: ReadableStream<Uint8Array> | ArrayBuffer | string
  contentType?: string
}

/**
 * Where updates live. Three kinds of keys are written:
 *
 * - `assets/<sha256>`: bundles and assets, content-addressed and immutable
 * - `updates/<id>.json`: one record per published update
 * - `channels/<channel>/<runtime version>/<platform>.json`: what that
 *   channel serves right now
 *
 * Implement this for any store that can get and put by key.
 */
export interface UpdatesStorage {
  get(key: string): Promise<StoredObject | null>
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { contentType?: string }
  ): Promise<void>
  /** Optional cheaper existence check. Falls back to `get`. */
  has?(key: string): Promise<boolean>
}

/** The part of an R2 bucket binding this package uses. */
export interface R2BucketLike {
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>
    httpMetadata?: { contentType?: string }
  } | null>
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>
  head(key: string): Promise<unknown>
}

/** The part of a KV namespace binding this package uses. */
export interface KVNamespaceLike {
  getWithMetadata(
    key: string,
    type: "arrayBuffer"
  ): Promise<{ value: ArrayBuffer | null; metadata: unknown }>
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { metadata?: unknown }
  ): Promise<unknown>
}

export interface StorageOptions {
  /** Prepended to every key, e.g. `"updates/"` to share a bucket. */
  prefix?: string
}

/** Stores updates in an R2 bucket. */
export function r2Storage(
  bucket: R2BucketLike,
  options: StorageOptions = {}
): UpdatesStorage {
  const prefix = options.prefix ?? ""
  return {
    async get(key) {
      const object = await bucket.get(prefix + key)
      if (!object) return null
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType,
      }
    },
    async put(key, value, putOptions) {
      await bucket.put(prefix + key, value, {
        httpMetadata: { contentType: putOptions?.contentType },
      })
    },
    async has(key) {
      return (await bucket.head(prefix + key)) != null
    },
  }
}

/**
 * Stores updates in a KV namespace. KV values are capped at 25 MiB and reads
 * are eventually consistent, so a publish can take up to a minute to show.
 * Prefer R2 unless bundles are small and you already have a namespace.
 */
export function kvStorage(
  namespace: KVNamespaceLike,
  options: StorageOptions = {}
): UpdatesStorage {
  const prefix = options.prefix ?? ""
  return {
    async get(key) {
      const { value, metadata } = await namespace.getWithMetadata(
        prefix + key,
        "arrayBuffer"
      )
      if (value == null) return null
      return { body: value, contentType: contentTypeOf(metadata) }
    },
    async put(key, value, putOptions) {
      await namespace.put(prefix + key, value, {
        metadata: { contentType: putOptions?.contentType },
      })
    },
  }
}

/** Keeps updates in memory. For tests and local experiments. */
export function memoryStorage(): UpdatesStorage & {
  entries: Map<string, StoredObject>
} {
  const entries = new Map<string, StoredObject>()
  return {
    entries,
    async get(key) {
      return entries.get(key) ?? null
    },
    async put(key, value, options) {
      entries.set(key, { body: value, contentType: options?.contentType })
    },
    async has(key) {
      return entries.has(key)
    },
  }
}

function contentTypeOf(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as { contentType?: unknown }).contentType
  return typeof value === "string" ? value : undefined
}
