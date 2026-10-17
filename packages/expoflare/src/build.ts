import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { detectOutput, type OutputMode } from "./detect.ts"
import {
  findUserConfig,
  generateConfig,
  readUserConfig,
  writeStarterConfig,
} from "./wrangler-config.ts"

export interface BuildOptions {
  /** Expo project root. Defaults to the current directory. */
  root?: string
  /** Where `expo export` writes. Defaults to `dist`. */
  distDir?: string
  /** Skip `expo export` and package an existing export. */
  skipExport?: boolean
  /** Extra arguments passed to `expo export`. */
  exportArgs?: string[]
  log?: (message: string) => void
}

export interface BuildResult {
  mode: OutputMode
  outDir: string
  configPath: string
}

export const OUT_DIR = ".expoflare"
const DEPLOY_CONFIG = path.join(".wrangler", "deploy", "config.json")

export function build(options: BuildOptions = {}): BuildResult {
  const root = path.resolve(options.root ?? ".")
  const distDir = path.resolve(root, options.distDir ?? "dist")
  const log = options.log ?? (() => {})

  if (!options.skipExport) {
    runExpoExport(root, distDir, options.exportArgs ?? [])
  }

  const output = detectOutput(distDir)
  log(`Expo web output: ${output.mode}`)

  const outDir = path.join(root, OUT_DIR)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const assetsDir = path.join(outDir, "assets")
  cpSync(output.clientDir, assetsDir, { recursive: true })
  prepareAssets(assetsDir, output.mode)

  let userConfigPath = findUserConfig(root)
  if (!userConfigPath) {
    userConfigPath = writeStarterConfig(root, projectName(root))
    log(`Created ${path.relative(root, userConfigPath)}`)
  }
  const userConfig = readUserConfig(userConfigPath)

  const userMain =
    typeof userConfig.main === "string"
      ? path.resolve(path.dirname(userConfigPath), userConfig.main)
      : null
  if (userMain && !existsSync(userMain)) {
    throw new Error(
      `"main" in ${userConfigPath} points to ${userMain}, which does not exist.`
    )
  }

  // Static and single-page output is assets-only unless the user brings a
  // Worker of their own.
  let entry: string | null = userMain
  let modulesDir: string | null = null
  if (output.serverDir) {
    assertExpoServerResolvable()
    modulesDir = path.join(outDir, "worker")
    cpSync(output.serverDir, modulesDir, {
      recursive: true,
      filter: (src) => !src.endsWith(".map"),
    })
    // expo-server imports routes and pages relative to the entry module, so
    // the entry has to sit at the root of the uploaded modules. A custom
    // entry is re-exported from there.
    entry = path.join(modulesDir, "index.js")
    writeFileSync(entry, entrySource(entry, userMain))
  }

  const config = generateConfig({
    userConfig,
    userConfigPath,
    outDir,
    mode: output.mode,
    assetsDir,
    entry,
    modulesDir,
  })
  const configPath = path.join(outDir, "wrangler.json")
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  // wrangler dev/deploy/versions read this and use our config instead of the
  // user's. Same mechanism the Cloudflare Vite plugin uses.
  const deployConfig = path.join(path.dirname(userConfigPath), DEPLOY_CONFIG)
  mkdirSync(path.dirname(deployConfig), { recursive: true })
  writeFileSync(
    deployConfig,
    `${JSON.stringify({ configPath: toPosix(path.relative(path.dirname(deployConfig), configPath)) }, null, 2)}\n`
  )

  log(
    `Wrote ${path.relative(root, configPath)}; run \`wrangler dev\` or \`wrangler deploy\``
  )
  return { mode: output.mode, outDir, configPath }
}

function runExpoExport(root: string, distDir: string, extraArgs: string[]) {
  let expoCli: string
  try {
    expoCli = createRequire(path.join(root, "package.json")).resolve(
      "expo/bin/cli"
    )
  } catch {
    throw new Error(
      `Could not find the \`expo\` package from ${root}. Is this an Expo project?`
    )
  }
  const result = spawnSync(
    process.execPath,
    [
      expoCli,
      "export",
      "--platform",
      "web",
      "--output-dir",
      distDir,
      ...extraArgs,
    ],
    { cwd: root, stdio: "inherit" }
  )
  if (result.status !== 0) {
    throw new Error(`expo export failed with exit code ${result.status}`)
  }
}

function prepareAssets(assetsDir: string, mode: OutputMode) {
  // Workers Static Assets serves 404.html for unmatched paths in 404-page mode.
  const notFound = path.join(assetsDir, "+not-found.html")
  const fourOhFour = path.join(assetsDir, "404.html")
  if (mode === "static" && existsSync(notFound) && !existsSync(fourOhFour)) {
    cpSync(notFound, fourOhFour)
  }

  // Metro content-hashes everything under _expo/static.
  const headers = path.join(assetsDir, "_headers")
  if (!existsSync(headers)) {
    writeFileSync(
      headers,
      "/_expo/static/*\n  Cache-Control: public, max-age=31536000, immutable\n"
    )
  }
}

function entrySource(entry: string, userMain: string | null): string {
  const header =
    "// Generated by expoflare. Do not edit; rebuilt on every `expoflare build`.\n"
  if (userMain) {
    let spec = toPosix(path.relative(path.dirname(entry), userMain))
    if (!spec.startsWith(".")) spec = `./${spec}`
    return `${header}export * from ${JSON.stringify(spec)}
export { default } from ${JSON.stringify(spec)}
`
  }
  return `${header}import { createExpoHandler } from "@thecomputerplumbers/expoflare/runtime"

const handler = createExpoHandler()

export default {
  fetch: (request, env, ctx) => handler(request, env, ctx),
}
`
}

function assertExpoServerResolvable() {
  try {
    import.meta.resolve("expo-server/adapter/workerd")
  } catch {
    throw new Error(
      "Server output needs the `expo-server` package. Install the version that matches your Expo SDK with `npx expo install expo-server`."
    )
  }
}

function projectName(root: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8")
    )
    if (typeof pkg.name === "string") {
      return pkg.name
        .replace(/^@[^/]+\//, "")
        .replace(/[^a-z0-9-]/gi, "-")
        .toLowerCase()
    }
  } catch {}
  return path.basename(root).toLowerCase()
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/")
}
