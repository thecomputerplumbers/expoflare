// Builds examples/basic with expoflare, serves it with `wrangler dev`, and
// checks pages, API routes, 404s, and static assets against the real runtime.
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../examples/basic", import.meta.url))
const port = 8790 + Math.floor(Math.random() * 100)
const base = `http://localhost:${port}`

const built = spawnSync("pnpm", ["exec", "expoflare", "build"], {
  cwd,
  stdio: "inherit",
})
if (built.status !== 0) process.exit(built.status ?? 1)

const dev = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "--port", String(port), "--inspector-port", "0"],
  {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  }
)
let devLog = ""
dev.stdout.on("data", (chunk) => (devLog += chunk))

try {
  await waitForServer()

  const hello = await fetch(`${base}/api/hello`)
  assert.equal(hello.status, 200)
  assert.deepEqual(await hello.json(), { hello: "world", path: "/api/hello" })

  const echo = await fetch(`${base}/api/echo/ada`, {
    method: "POST",
    body: "hi",
  })
  assert.deepEqual(await echo.json(), { name: "ada", body: "hi" })
  assert.equal((await fetch(`${base}/api/echo/ada`)).status, 405)

  const home = await fetch(`${base}/`)
  assert.equal(home.status, 200)
  const html = await home.text()
  assert.match(html, /Expo on Cloudflare Workers/)

  assert.equal((await fetch(`${base}/users/ada`)).status, 200)
  assert.equal((await fetch(`${base}/does-not-exist`)).status, 404)

  const script = html.match(/\/_expo\/static\/js\/web\/[^"]+\.js/)?.[0]
  assert.ok(script, "home page references a web bundle")
  const bundle = await fetch(`${base}${script}`)
  assert.equal(bundle.status, 200)
  assert.match(bundle.headers.get("cache-control") ?? "", /immutable/)

  console.log("e2e: all checks passed")
} catch (error) {
  console.error(devLog)
  throw error
} finally {
  process.kill(-dev.pid)
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
