import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { OutputMode } from "./detect.ts"

export type WranglerConfig = Record<string, unknown>

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]

export function findUserConfig(root: string): string | null {
  for (const name of CONFIG_NAMES) {
    const file = path.join(root, name)
    if (existsSync(file)) return file
  }
  return null
}

export function readUserConfig(file: string): WranglerConfig {
  if (file.endsWith(".toml")) {
    throw new Error(
      `expoflare reads wrangler.jsonc or wrangler.json, not TOML. Convert ${path.basename(file)} to wrangler.jsonc.`
    )
  }
  const errors: ParseError[] = []
  const config: unknown = parse(readFileSync(file, "utf8"), errors, {
    allowTrailingComma: true,
  })
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ")
    throw new Error(`Could not parse ${file}: ${detail}`)
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must contain a JSON object.`)
  }
  return config as WranglerConfig
}

/** Writes a starter wrangler.jsonc the user owns from then on. */
export function writeStarterConfig(root: string, name: string): string {
  const file = path.join(root, "wrangler.jsonc")
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    file,
    `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(name)},
  "compatibility_date": "${today}",
  // Add bindings (KV, D1, R2, vars, ...) here. \`expoflare build\` fills in
  // "main", "assets", and module rules from the Expo export.
}
`
  )
  return file
}

/**
 * Keys wrangler doesn't inherit from the top level into an environment
 * (bindings, vars, and the like). Everything else is inherited unless the
 * environment sets it. Mirrors `notInheritable` in wrangler's config
 * normalization.
 */
const NOT_INHERITABLE = new Set([
  "vars",
  "secrets",
  "define",
  "durable_objects",
  "workflows",
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "cloudchamber",
  "containers",
  "send_email",
  "queues",
  "connect",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "tail_consumers",
  "streaming_tail_consumers",
  "unsafe",
  "browser",
  "analytics",
  "ai",
  "images",
  "stream",
  "media",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "ratelimits",
  "vpc_services",
  "vpc_networks",
  "version_metadata",
])

/**
 * wrangler rejects a redirected config that has environments, so the
 * environment is picked at build time: its settings are folded over the top
 * level the way wrangler would, and `env` is dropped. With no environment
 * selected, the top level is used as is.
 */
export function resolveEnvironment(
  userConfig: WranglerConfig,
  envName: string | undefined
): WranglerConfig {
  const { env, ...topLevel } = userConfig
  const envs = isRecord(env) ? env : {}
  if (!envName) return topLevel

  const rawEnv = envs[envName]
  if (rawEnv === undefined) {
    const names = Object.keys(envs)
    if (names.length > 0) {
      throw new Error(
        `No environment named "${envName}" in the wrangler config. Available: ${names.join(", ")}.`
      )
    }
    // wrangler warns and uses the top level, still deploying to <name>-<env>.
    return withEnvName(topLevel, undefined, envName)
  }
  if (!isRecord(rawEnv)) {
    throw new Error(
      `"env.${envName}" in the wrangler config must be an object.`
    )
  }

  const resolved: WranglerConfig = {}
  for (const [key, value] of Object.entries(topLevel)) {
    if (!NOT_INHERITABLE.has(key)) resolved[key] = value
  }
  Object.assign(resolved, rawEnv)
  return withEnvName(resolved, rawEnv.name, envName, topLevel.name)
}

function withEnvName(
  config: WranglerConfig,
  envLevelName: unknown,
  envName: string,
  topLevelName: unknown = config.name
): WranglerConfig {
  // An environment deploys as its own Worker, "<name>-<env>", unless it sets
  // a name.
  if (typeof envLevelName === "string") return { ...config, name: envLevelName }
  if (typeof topLevelName === "string" && topLevelName) {
    return { ...config, name: `${topLevelName}-${envName}` }
  }
  return config
}

export interface GeneratedConfigInput {
  userConfig: WranglerConfig
  userConfigPath: string
  /** Where the generated config is written; relative paths resolve from here. */
  outDir: string
  mode: OutputMode
  assetsDir: string
  /** Worker entry, or null for an assets-only Worker. */
  entry: string | null
  /** Directory of Worker modules loaded at runtime by the entry. */
  modulesDir: string | null
  /** wrangler environment to build for (`env.<name>`), if any. */
  envName?: string
}

/**
 * Builds the config wrangler reads in place of the user's through
 * `.wrangler/deploy/config.json`. The user's bindings, vars, and routes pass
 * through, resolved for the selected environment; expoflare owns the entry,
 * assets, and module rules.
 */
export function generateConfig(input: GeneratedConfigInput): WranglerConfig {
  const { outDir } = input
  const userConfig = resolveEnvironment(input.userConfig, input.envName)
  const userDir = path.dirname(input.userConfigPath)
  const rel = (to: string) => toPosix(path.relative(outDir, to)) || "."

  const {
    $schema: _schema,
    main: _main,
    assets: userAssets,
    rules: userRules,
    base_dir: _baseDir,
    find_additional_modules: _find,
    no_bundle: _noBundle,
    compatibility_flags: userFlags,
    ...rest
  } = userConfig

  const config: WranglerConfig = rebasePaths(rest, userDir, outDir)

  config.compatibility_date ??= new Date().toISOString().slice(0, 10)

  // Redirected-config metadata wrangler reads in place of `env`. With it,
  // `wrangler deploy --env <other>` fails instead of deploying the wrong build.
  const envNames = isRecord(input.userConfig.env)
    ? Object.keys(input.userConfig.env)
    : []
  if (typeof input.userConfig.name === "string") {
    config.topLevelName = input.userConfig.name
  }
  if (envNames.length > 0) config.definedEnvironments = envNames
  if (input.envName) config.targetEnvironment = input.envName

  const assets: Record<string, unknown> = {
    ...(isRecord(userAssets) ? userAssets : {}),
    directory: rel(input.assetsDir),
  }
  if (input.mode === "single")
    assets.not_found_handling ??= "single-page-application"
  if (input.mode === "static") assets.not_found_handling ??= "404-page"
  config.assets = assets

  if (input.entry) {
    config.main = rel(input.entry)
    // expo-server uses AsyncLocalStorage from node:async_hooks.
    config.compatibility_flags = unique([
      ...(Array.isArray(userFlags) ? userFlags : []),
      "nodejs_compat",
    ])
  } else if (Array.isArray(userFlags)) {
    config.compatibility_flags = userFlags
  }

  if (input.modulesDir) {
    config.base_dir = rel(input.modulesDir)
    config.find_additional_modules = true
    config.rules = [
      // Metro emits API routes and the SSR renderer as CommonJS bundles.
      { type: "CommonJS", globs: ["_expo/**/*.js"], fallthrough: false },
      // Pre-rendered pages and routes.json, read by expo-server as text.
      { type: "Text", globs: ["**/*.html", "**/*.json"], fallthrough: true },
      ...(Array.isArray(userRules) ? userRules : []),
    ]
  } else if (Array.isArray(userRules)) {
    // A custom entry with static or single output is bundled from source:
    // keep its module rules (e.g. .sql imported as Text).
    config.rules = userRules
  }

  return config
}

/** Paths in a wrangler config are relative to the file they appear in. */
function rebasePaths(
  config: WranglerConfig,
  fromDir: string,
  toDir: string
): WranglerConfig {
  const rebase = (value: unknown) =>
    typeof value === "string" && !path.isAbsolute(value)
      ? toPosix(path.relative(toDir, path.resolve(fromDir, value)))
      : value

  const out: WranglerConfig = { ...config }
  if ("tsconfig" in out) out.tsconfig = rebase(out.tsconfig)
  if (Array.isArray(out.d1_databases)) {
    out.d1_databases = out.d1_databases.map((db: unknown) =>
      isRecord(db) && "migrations_dir" in db
        ? { ...db, migrations_dir: rebase(db.migrations_dir) }
        : db
    )
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/")
}
