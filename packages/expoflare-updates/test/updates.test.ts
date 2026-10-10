import assert from "node:assert/strict"
import { createHash, createVerify, generateKeyPairSync } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  createUpdatesHandler,
  kvStorage,
  memoryStorage,
  r2Storage,
  type UpdatesHandlerOptions,
  type UpdatesStorage,
} from "../src/index.ts"
import { publish, rollback } from "../src/publish.ts"

const BASE = "https://app.example/updates"
const TOKEN = "publish-secret"
const BUNDLE = "var bundle = 1"
const IMAGE = "not really a png"

function exportDir(bundle = BUNDLE): string {
  const dist = mkdtempSync(path.join(tmpdir(), "expoflare-updates-"))
  const files: Record<string, string> = {
    "metadata.json": JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: {
          bundle: "_expo/static/js/ios/entry-abc.hbc",
          assets: [{ path: "assets/0123abcd", ext: "png" }],
        },
      },
    }),
    "_expo/static/js/ios/entry-abc.hbc": bundle,
    "assets/0123abcd": IMAGE,
  }
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dist, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return dist
}

function server(options: Partial<UpdatesHandlerOptions> = {}) {
  const storage = memoryStorage()
  const handler = createUpdatesHandler({
    storage,
    publishToken: TOKEN,
    ...options,
  })
  const send: typeof fetch = (input, init) =>
    handler(new Request(input, init), undefined)
  const target = {
    url: BASE,
    token: TOKEN,
    fetch: send,
    platform: "ios" as const,
    channel: "production",
    runtimeVersion: "1.0.0",
  }
  const publishExport = (bundle?: string, channel = "production") =>
    publish({
      ...target,
      channel,
      distDir: exportDir(bundle),
      skipExport: true,
      expoConfig: { name: "Example", slug: "example" },
      message: "A test update",
    })
  const manifest = (headers: Record<string, string> = {}) =>
    send(`${BASE}/manifest`, {
      headers: {
        "expo-protocol-version": "1",
        "expo-platform": "ios",
        "expo-runtime-version": "1.0.0",
        "expo-channel-name": "production",
        ...headers,
      },
    })
  return { storage, send, target, publishExport, manifest }
}

interface Part {
  headers: Record<string, string>
  body: string
}

/** Splits a multipart/mixed response the way a client would. */
async function parts(response: Response): Promise<Record<string, Part>> {
  const boundary = /boundary=(.+)$/.exec(
    response.headers.get("content-type") ?? ""
  )?.[1]
  assert.ok(boundary, "multipart response has a boundary")
  const out: Record<string, Part> = {}
  for (const chunk of (await response.text()).split(`--${boundary}`)) {
    const split = chunk.indexOf("\r\n\r\n")
    if (split === -1) continue
    const headers = Object.fromEntries(
      chunk
        .slice(0, split)
        .trim()
        .split("\r\n")
        .map((line) => {
          const colon = line.indexOf(":")
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 2)]
        })
    )
    const name = /name="([^"]+)"/.exec(
      headers["content-disposition"] ?? ""
    )?.[1]
    assert.ok(name, "part has a name")
    out[name] = { headers, body: chunk.slice(split + 4, -2) }
  }
  return out
}

const sha256 = (value: string, encoding: "base64url" | "hex") =>
  createHash("sha256").update(value).digest(encoding)

test("publishes an export and serves it as a manifest", async () => {
  const { publishExport, manifest, send } = server()
  const update = await publishExport()

  const response = await manifest()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("expo-protocol-version"), "1")
  assert.equal(response.headers.get("expo-sfv-version"), "0")
  assert.match(response.headers.get("cache-control") ?? "", /private/)

  const { manifest: part, extensions } = await parts(response)
  assert.ok(part && extensions)
  assert.match(part.headers["content-type"] ?? "", /^application\/json/)
  assert.equal(part.headers["expo-signature"], undefined)

  const body = JSON.parse(part.body)
  assert.equal(body.id, update.id)
  assert.equal(body.runtimeVersion, "1.0.0")
  assert.equal(new Date(body.createdAt).toISOString(), body.createdAt)
  assert.deepEqual(body.launchAsset, {
    hash: sha256(BUNDLE, "base64url"),
    key: sha256(BUNDLE, "hex"),
    contentType: "application/javascript",
    fileExtension: ".bundle",
    url: `${BASE}/assets/${sha256(BUNDLE, "base64url")}`,
  })
  assert.deepEqual(body.assets, [
    {
      hash: sha256(IMAGE, "base64url"),
      key: sha256(IMAGE, "hex"),
      contentType: "image/png",
      fileExtension: ".png",
      url: `${BASE}/assets/${sha256(IMAGE, "base64url")}`,
    },
  ])
  assert.deepEqual(body.extra, {
    expoClient: { name: "Example", slug: "example" },
  })

  const bundle = await send(body.launchAsset.url)
  assert.equal(bundle.status, 200)
  assert.equal(await bundle.text(), BUNDLE)
  assert.equal(bundle.headers.get("content-type"), "application/javascript")
  assert.match(bundle.headers.get("cache-control") ?? "", /immutable/)
})

test("serves nothing until something is published for that runtime", async () => {
  const { publishExport, manifest } = server()
  assert.equal((await manifest()).status, 204)
  assert.equal(
    (await manifest({ "expo-protocol-version": "0" })).status,
    404,
    "protocol 0 has no way to say no update"
  )

  await publishExport()
  assert.equal((await manifest()).status, 200)
  assert.equal(
    (await manifest({ "expo-runtime-version": "2.0.0" })).status,
    204
  )
  assert.equal((await manifest({ "expo-platform": "android" })).status, 204)
  assert.equal((await manifest({ "expo-channel-name": "preview" })).status, 204)
  assert.equal((await manifest({ "expo-platform": "windows" })).status, 400)
})

test("keeps channels apart and serves the newest update on each", async () => {
  const { publishExport, manifest } = server()
  await publishExport("var bundle = 1")
  const preview = await publishExport("var bundle = 2", "preview")
  const production = await publishExport("var bundle = 3")

  const served = async (channel: string) =>
    JSON.parse(
      (await parts(await manifest({ "expo-channel-name": channel }))).manifest!
        .body
    ).id
  assert.equal(await served("production"), production.id)
  assert.equal(await served("preview"), preview.id)
})

test("tells an app that already runs the update there is nothing new", async () => {
  const { publishExport, manifest } = server()
  const update = await publishExport()
  const response = await manifest({ "expo-current-update-id": update.id })
  const { directive, manifest: part } = await parts(response)
  assert.equal(part, undefined)
  assert.deepEqual(JSON.parse(directive!.body), { type: "noUpdateAvailable" })
})

test("uploads each file once", async () => {
  const { publishExport, storage } = server()
  const logged: string[] = []
  await publishExport()
  const assets = () =>
    [...storage.entries.keys()].filter((key) => key.startsWith("assets/"))
  assert.equal(assets().length, 2)

  const { target } = server()
  await publish({
    ...target,
    // Same server as above, so both files are already there.
    fetch: (input, init) =>
      createUpdatesHandler({ storage, publishToken: TOKEN })(
        new Request(input, init),
        undefined
      ),
    distDir: exportDir(),
    skipExport: true,
    expoConfig: {},
    log: (message) => logged.push(message),
  })
  assert.equal(assets().length, 2)
  assert.ok(logged.some((line) => line.startsWith("Uploaded 0 of 2")))
})

test("publishing needs the token, and is off without one", async () => {
  const { send, storage } = server()
  const hash = sha256(BUNDLE, "base64url")
  const put = (token: string, body = BUNDLE, on = send) =>
    on(`${BASE}/assets/${hash}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body,
    })

  assert.equal((await put("wrong")).status, 401)
  assert.equal((await put("")).status, 401)
  assert.equal(
    (await send(`${BASE}/updates`, { method: "POST", body: "{}" })).status,
    401
  )
  assert.equal((await put(TOKEN, "tampered")).status, 400)
  assert.equal(storage.entries.size, 0)
  assert.equal((await put(TOKEN)).status, 201)

  const readOnly = server({ publishToken: undefined })
  assert.equal((await put(TOKEN, BUNDLE, readOnly.send)).status, 404)
  assert.equal(
    (
      await readOnly.send(`${BASE}/updates`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{}",
      })
    ).status,
    404
  )
})

test("rolls back to an earlier update as a new one", async () => {
  const { publishExport, manifest, target } = server()
  const first = await publishExport("var bundle = 1")
  const second = await publishExport("var bundle = 2")

  await rollback({ ...target, updateId: first.id })
  const body = JSON.parse((await parts(await manifest())).manifest!.body)
  assert.notEqual(body.id, first.id, "a new id, or apps on it see no change")
  assert.notEqual(body.id, second.id)
  assert.ok(body.createdAt > second.createdAt, "newer, or apps ignore it")
  assert.equal(body.launchAsset.hash, sha256("var bundle = 1", "base64url"))

  await assert.rejects(
    rollback({ ...target, updateId: first.id, runtimeVersion: "2.0.0" }),
    /built for ios runtime 1\.0\.0/
  )
  await assert.rejects(
    rollback({ ...target, updateId: "missing" }),
    /doesn't exist/
  )
})

test("rolls back to the embedded bundle with a directive", async () => {
  const { publishExport, manifest, target } = server()
  await publishExport()
  await rollback(target)

  const { directive } = await parts(await manifest())
  const body = JSON.parse(directive!.body)
  assert.equal(body.type, "rollBackToEmbedded")
  assert.equal(
    new Date(body.parameters.commitTime).toISOString(),
    body.parameters.commitTime
  )

  const onEmbedded = await manifest({
    "expo-current-update-id": "embedded-id",
    "expo-embedded-update-id": "embedded-id",
  })
  assert.deepEqual(JSON.parse((await parts(onEmbedded)).directive!.body), {
    type: "noUpdateAvailable",
  })
  assert.equal((await manifest({ "expo-protocol-version": "0" })).status, 404)
})

for (const type of ["pkcs1", "pkcs8"] as const) {
  test(`signs manifests and directives with a ${type} key`, async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    const { publishExport, manifest } = server({
      signingKey: privateKey.export({ type, format: "pem" }).toString(),
    })
    const update = await publishExport()

    const verify = (part: Part | undefined) => {
      assert.ok(part)
      const header = /^sig="([^"]+)", keyid="main"$/.exec(
        part.headers["expo-signature"] ?? ""
      )
      assert.ok(header, "expo-signature is a structured-field dictionary")
      return createVerify("RSA-SHA256")
        .update(part.body)
        .verify(publicKey, header[1]!, "base64")
    }
    const expect = { "expo-expect-signature": 'sig, keyid="main"' }
    assert.ok(verify((await parts(await manifest(expect))).manifest))
    assert.ok(
      verify(
        (
          await parts(
            await manifest({ ...expect, "expo-current-update-id": update.id })
          )
        ).directive
      )
    )
  })
}

test("refuses an app that expects signatures when there is no key", async () => {
  const { publishExport, manifest } = server()
  await publishExport()
  const response = await manifest({
    "expo-expect-signature": 'sig, keyid="main"',
  })
  assert.equal(response.status, 400)
})

test("mounts anywhere and can serve assets from another origin", async () => {
  const storage = memoryStorage()
  const handler = createUpdatesHandler<{ TOKEN: string }>({
    storage: () => storage,
    publishToken: (env) => env.TOKEN,
    basePath: "/api/ota/",
    assetBaseUrl: "https://cdn.example/assets/",
  })
  const send: typeof fetch = (input, init) =>
    handler(new Request(input, init), { TOKEN })

  await publish({
    url: "https://app.example/api/ota",
    token: TOKEN,
    fetch: send,
    platform: "ios",
    channel: "production",
    runtimeVersion: "1.0.0",
    distDir: exportDir(),
    skipExport: true,
    expoConfig: {},
  })
  const response = await send(
    "https://app.example/api/ota/manifest?platform=ios&runtime-version=1.0.0"
  )
  const body = JSON.parse((await parts(response)).manifest!.body)
  assert.equal(
    body.launchAsset.url,
    `https://cdn.example/assets/${sha256(BUNDLE, "base64url")}`
  )
  assert.equal((await send(`${BASE}/manifest`)).status, 404)
})

test("r2 and kv adapters keep content types and honor the prefix", async () => {
  const objects = new Map<
    string,
    { value: ArrayBuffer | string; type?: string }
  >()
  const stream = (value: ArrayBuffer | string) =>
    new Response(value).body as ReadableStream<Uint8Array>

  const adapters: Record<string, UpdatesStorage> = {
    r2: r2Storage(
      {
        async get(key) {
          const object = objects.get(key)
          return object
            ? {
                body: stream(object.value),
                httpMetadata: { contentType: object.type },
              }
            : null
        },
        async put(key, value, options) {
          objects.set(key, { value, type: options?.httpMetadata?.contentType })
        },
        async head(key) {
          return objects.has(key) ? {} : null
        },
      },
      { prefix: "ota/" }
    ),
    kv: kvStorage(
      {
        async getWithMetadata(key) {
          const object = objects.get(key)
          return {
            value: object
              ? await new Response(object.value).arrayBuffer()
              : null,
            metadata: object ? { contentType: object.type } : null,
          }
        },
        async put(key, value, options) {
          const metadata = options?.metadata as { contentType?: string }
          objects.set(key, { value, type: metadata.contentType })
        },
      },
      { prefix: "ota/" }
    ),
  }

  for (const [name, storage] of Object.entries(adapters)) {
    objects.clear()
    assert.equal(await storage.get("assets/x"), null, name)
    await storage.put("assets/x", "hello", { contentType: "text/plain" })
    assert.deepEqual([...objects.keys()], ["ota/assets/x"], name)
    const object = await storage.get("assets/x")
    assert.equal(object?.contentType, "text/plain", name)
    assert.equal(await new Response(object?.body).text(), "hello", name)
    if (storage.has) {
      assert.equal(await storage.has("assets/x"), true, name)
      assert.equal(await storage.has("assets/y"), false, name)
    }
  }
})
