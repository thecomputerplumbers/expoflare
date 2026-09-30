import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { build } from "../src/build.ts"
import { detectOutput } from "../src/detect.ts"
import { generateConfig } from "../src/wrangler-config.ts"

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "expoflare-"))
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"))

const SERVER_EXPORT = {
  "package.json": `{"name":"@acme/My App"}`,
  "dist/client/_expo/static/js/web/entry-abc.js": "",
  "dist/server/_expo/routes.json": `{"apiRoutes":[],"htmlRoutes":[]}`,
  "dist/server/_expo/functions/api/hello+api.js": "",
  "dist/server/_expo/functions/api/hello+api.js.map": "",
  "dist/server/index.html": "<html></html>",
}

test("detects each expo export shape", () => {
  const single = project({ "dist/index.html": "" })
  assert.equal(detectOutput(path.join(single, "dist")).mode, "single")

  const statik = project({ "dist/index.html": "", "dist/+not-found.html": "" })
  assert.equal(detectOutput(path.join(statik, "dist")).mode, "static")

  const server = project(SERVER_EXPORT)
  assert.equal(detectOutput(path.join(server, "dist")).mode, "server")

  assert.throws(
    () => detectOutput(path.join(project({}), "dist")),
    /No Expo web export/
  )
})

test("server output: generates entry, modules, config, and redirect", () => {
  const root = project(SERVER_EXPORT)
  const result = build({ root, skipExport: true })
  assert.equal(result.mode, "server")

  const config = readJson(result.configPath)
  assert.equal(config.name, "my-app")
  assert.equal(config.main, "worker/index.js")
  assert.equal(config.base_dir, "worker")
  assert.equal(config.find_additional_modules, true)
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"])
  assert.equal(config.assets.directory, "assets")

  const out = path.join(root, ".expoflare")
  assert.match(
    readFileSync(path.join(out, "worker/index.js"), "utf8"),
    /createExpoHandler/
  )
  assert.throws(() =>
    readFileSync(path.join(out, "worker/_expo/functions/api/hello+api.js.map"))
  )
  assert.match(
    readFileSync(path.join(out, "assets/_headers"), "utf8"),
    /immutable/
  )

  assert.deepEqual(readJson(path.join(root, ".wrangler/deploy/config.json")), {
    configPath: "../../.expoflare/wrangler.json",
  })
})

test("static output: assets-only with a 404 page", () => {
  const root = project({
    "wrangler.jsonc": `{ "name": "site", "compatibility_date": "2026-01-01", }`,
    "dist/index.html": "home",
    "dist/+not-found.html": "missing",
  })
  const result = build({ root, skipExport: true })
  const config = readJson(result.configPath)
  assert.equal(config.main, undefined)
  assert.equal(config.assets.not_found_handling, "404-page")
  assert.equal(
    readFileSync(path.join(root, ".expoflare/assets/404.html"), "utf8"),
    "missing"
  )
})

test("custom main is re-exported from beside the server modules", () => {
  const root = project({
    ...SERVER_EXPORT,
    "wrangler.jsonc": `{ "name": "app", "main": "src/worker.ts" }`,
    "src/worker.ts": "export default {}",
  })
  build({ root, skipExport: true })
  const entry = readFileSync(
    path.join(root, ".expoflare/worker/index.js"),
    "utf8"
  )
  assert.match(entry, /export \* from "\.\.\/\.\.\/src\/worker\.ts"/)
  assert.match(entry, /export \{ default \} from "\.\.\/\.\.\/src\/worker\.ts"/)
})

test("keeps user bindings and flags and rebases their paths", () => {
  const root = "/app"
  const config = generateConfig({
    userConfig: {
      name: "app",
      main: "ignored.ts",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      assets: { binding: "ASSETS", not_found_handling: "none" },
      d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
      env: {
        staging: {
          d1_databases: [{ binding: "DB", migrations_dir: "migrations" }],
        },
      },
    },
    userConfigPath: "/app/wrangler.jsonc",
    outDir: path.join(root, ".expoflare"),
    mode: "static",
    assetsDir: "/app/.expoflare/assets",
    entry: null,
    modulesDir: null,
  })
  assert.deepEqual(config.assets, {
    binding: "ASSETS",
    not_found_handling: "none",
    directory: "assets",
  })
  assert.deepEqual(config.compatibility_flags, [
    "nodejs_compat",
    "global_fetch_strictly_public",
  ])
  assert.deepEqual(config.d1_databases, [
    { binding: "DB", migrations_dir: "../migrations" },
  ])
  assert.deepEqual(
    (config.env as any).staging.d1_databases[0].migrations_dir,
    "../migrations"
  )
  assert.equal(config.main, undefined)
})
