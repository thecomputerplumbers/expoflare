// Serves examples/updates with `wrangler dev` (a real Worker and local R2),
// publishes a real `expo export` of examples/basic with the CLI, and reads it
// back the way expo-updates does: manifest, signature, bundle, assets.
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { createHash, createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../examples/updates", import.meta.url))
const port = 8890 + Math.floor(Math.random() * 100)
const base = `http://localhost:${port}/updates`
const token = "e2e-publish-token"

// The key format `expo-updates codesigning:generate` writes.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
const devVars = path.join(cwd, ".dev.vars")
writeFileSync(
  devVars,
  `UPDATES_TOKEN="${token}"\nUPDATES_SIGNING_KEY="${privateKey.export({ type: "pkcs1", format: "pem" })}"\n`
)

const state = mkdtempSync(path.join(tmpdir(), "expoflare-updates-e2e-"))
const dev = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    state,
  ],
  { cwd, stdio: ["ignore", "pipe", "inherit"], detached: true }
)
let devLog = ""
dev.stdout.on("data", (chunk) => (devLog += chunk))

const cli = (...args) => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "expoflare-updates",
      ...args,
      "--root",
      "../basic",
      "--channel",
      "production",
      "--platform",
      "ios",
      "--runtime-version",
      "1.0.0",
      "--url",
      base,
      "--token",
      token,
    ],
    { cwd, stdio: "inherit" }
  )
  assert.equal(result.status, 0, `expoflare-updates ${args[0]} failed`)
}

// `expo export` can outlast the keep-alive of the connection the first check
// opened, and reusing a socket the server has closed fails once.
const get = (url, init) => fetch(url, init).catch(() => fetch(url, init))

const manifest = (headers = {}) =>
  get(`${base}/manifest`, {
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0.0",
      "expo-channel-name": "production",
      "expo-expect-signature": 'sig, keyid="main"',
      ...headers,
    },
  })

try {
  await waitForServer()
  assert.equal((await manifest()).status, 204, "nothing published yet")

  cli("publish", "--message", "e2e")

  const response = await manifest()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("expo-protocol-version"), "1")
  const { manifest: part } = await parts(response)
  assert.ok(verified(part), "the manifest is signed with the configured key")

  const body = JSON.parse(part.body)
  assert.equal(body.runtimeVersion, "1.0.0")
  assert.equal(body.extra.expoClient.slug, "expoflare-example-basic")
  assert.match(body.launchAsset.url, new RegExp(`^${base}/assets/`))

  // The client checks every download against the manifest's hash.
  for (const asset of [body.launchAsset, ...body.assets]) {
    const file = await fetch(asset.url)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get("content-type"), asset.contentType)
    assert.match(file.headers.get("cache-control") ?? "", /immutable/)
    const hash = createHash("sha256")
      .update(Buffer.from(await file.arrayBuffer()))
      .digest("base64url")
    assert.equal(hash, asset.hash)
  }
  console.log(`e2e: served a bundle and ${body.assets.length} assets from R2`)

  const upToDate = await parts(
    await manifest({ "expo-current-update-id": body.id })
  )
  assert.deepEqual(JSON.parse(upToDate.directive.body), {
    type: "noUpdateAvailable",
  })
  assert.equal(
    (await manifest({ "expo-runtime-version": "2.0.0" })).status,
    204
  )
  assert.equal(
    (await fetch(`${base}/updates`, { method: "POST", body: "{}" })).status,
    401
  )

  cli("rollback")
  const rolledBack = await parts(await manifest())
  assert.ok(verified(rolledBack.directive), "the directive is signed")
  assert.equal(JSON.parse(rolledBack.directive.body).type, "rollBackToEmbedded")

  console.log("e2e: all checks passed")
} catch (error) {
  console.error(devLog)
  throw error
} finally {
  process.kill(-dev.pid)
  rmSync(devVars, { force: true })
  rmSync(state, { recursive: true, force: true })
}

function verified(part) {
  const signature = /^sig="([^"]+)", keyid="main"$/.exec(
    part.headers["expo-signature"] ?? ""
  )?.[1]
  assert.ok(signature, "the part has an expo-signature header")
  return createVerify("RSA-SHA256")
    .update(part.body)
    .verify(publicKey, signature, "base64")
}

async function parts(response) {
  const boundary = /boundary=(.+)$/.exec(
    response.headers.get("content-type") ?? ""
  )?.[1]
  assert.ok(boundary, "multipart response has a boundary")
  const out = {}
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
    const name = /name="([^"]+)"/.exec(headers["content-disposition"])[1]
    out[name] = { headers, body: chunk.slice(split + 4, -2) }
  }
  return out
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error("wrangler dev did not start")
}
