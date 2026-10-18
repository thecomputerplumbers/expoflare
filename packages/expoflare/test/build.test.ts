import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { build } from "../src/build.ts"
import { detectOutput } from "../src/detect.ts"
import { generateConfig, resolveEnvironment } from "../src/wrangler-config.ts"

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
  assert.equal(config.main, undefined)
})

test("custom main with single output keeps the user's module rules", () => {
  const rules = [{ type: "Text", globs: ["**/*.sql"], fallthrough: true }]
  const config = generateConfig({
    userConfig: { name: "app", main: "src/worker.ts", rules },
    userConfigPath: "/app/wrangler.jsonc",
    outDir: "/app/.expoflare",
    mode: "single",
    assetsDir: "/app/.expoflare/assets",
    entry: "/app/src/worker.ts",
    modulesDir: null,
  })
  assert.equal(config.main, "../src/worker.ts")
  assert.deepEqual(config.rules, rules)
})

const ENV_CONFIG = {
  name: "app",
  compatibility_date: "2026-01-01",
  routes: ["app.example.com/*"],
  vars: { STAGE: "dev" },
  kv_namespaces: [{ binding: "CACHE", id: "dev" }],
  env: {
    production: {
      routes: ["example.com/*"],
      vars: { STAGE: "production" },
      d1_databases: [{ binding: "DB", migrations_dir: "db/migrations" }],
      rules: [{ type: "Text", globs: ["**/*.graphql"] }],
    },
    staging: { name: "app-preview" },
  },
}

test("drops env when no environment is selected", () => {
  const config = generateConfig({
    userConfig: ENV_CONFIG,
    userConfigPath: "/app/wrangler.jsonc",
    outDir: "/app/.expoflare",
    mode: "static",
    assetsDir: "/app/.expoflare/assets",
    entry: null,
    modulesDir: null,
  })
  assert.equal(config.env, undefined)
  assert.equal(config.name, "app")
  assert.deepEqual(config.vars, { STAGE: "dev" })
  assert.equal(config.topLevelName, "app")
  assert.deepEqual(config.definedEnvironments, ["production", "staging"])
  assert.equal(config.targetEnvironment, undefined)
})

test("folds the selected environment over the top level like wrangler", () => {
  const config = generateConfig({
    userConfig: ENV_CONFIG,
    userConfigPath: "/app/wrangler.jsonc",
    outDir: "/app/.expoflare",
    mode: "server",
    assetsDir: "/app/.expoflare/assets",
    entry: "/app/.expoflare/worker/index.js",
    modulesDir: "/app/.expoflare/worker",
    envName: "production",
  })
  assert.equal(config.env, undefined)
  assert.equal(config.name, "app-production")
  assert.equal(config.compatibility_date, "2026-01-01")
  assert.deepEqual(config.routes, ["example.com/*"])
  assert.deepEqual(config.vars, { STAGE: "production" })
  // Bindings aren't inherited from the top level.
  assert.equal(config.kv_namespaces, undefined)
  assert.deepEqual(config.d1_databases, [
    { binding: "DB", migrations_dir: "../db/migrations" },
  ])
  // Environment rules go after expoflare's own, like top-level rules.
  assert.deepEqual((config.rules as unknown[]).at(-1), {
    type: "Text",
    globs: ["**/*.graphql"],
  })
  assert.equal(config.targetEnvironment, "production")
})

test("resolveEnvironment: names, missing environments", () => {
  assert.equal(resolveEnvironment(ENV_CONFIG, "staging").name, "app-preview")
  assert.deepEqual(resolveEnvironment(ENV_CONFIG, "staging").vars, undefined)
  assert.throws(
    () => resolveEnvironment(ENV_CONFIG, "qa"),
    /No environment named "qa".*production, staging/
  )
  // No environments at all: wrangler keeps the top level under <name>-<env>.
  const plain = resolveEnvironment({ name: "app", vars: { A: "1" } }, "qa")
  assert.equal(plain.name, "app-qa")
  assert.deepEqual(plain.vars, { A: "1" })
})

test("build --env picks up CLOUDFLARE_ENV and an environment's main", () => {
  const root = project({
    "wrangler.jsonc": `{
      "name": "site",
      "compatibility_date": "2026-01-01",
      "env": { "production": { "main": "src/prod.ts", "vars": { "A": "1" } } },
    }`,
    "dist/index.html": "home",
    "src/prod.ts": "export default {}",
  })
  const previous = process.env.CLOUDFLARE_ENV
  process.env.CLOUDFLARE_ENV = "production"
  try {
    const config = readJson(build({ root, skipExport: true }).configPath)
    assert.equal(config.name, "site-production")
    assert.equal(config.main, "../src/prod.ts")
    assert.deepEqual(config.vars, { A: "1" })
    assert.equal(config.env, undefined)
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_ENV
    else process.env.CLOUDFLARE_ENV = previous
  }
  const flag = readJson(build({ root, skipExport: true, env: "" }).configPath)
  assert.equal(flag.name, "site")
})
