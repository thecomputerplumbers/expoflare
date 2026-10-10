import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { AssetRecord, Platform, UpdateRecord } from "./protocol.ts"

interface Target {
  /** Where the handler is mounted, e.g. `https://example.com/updates`. */
  url: string
  /** The handler's `publishToken`. */
  token: string
  fetch?: typeof fetch
}

export interface PublishOptions extends Target {
  platform: Platform
  channel: string
  /** Expo project root. Defaults to the current directory. */
  root?: string
  /** Where `expo export` writes. Defaults to a per-platform cache directory. */
  distDir?: string
  /** Defaults to what the project's `runtimeVersion` policy resolves to. */
  runtimeVersion?: string
  message?: string
  /** Publish an existing export instead of running `expo export`. */
  skipExport?: boolean
  /** Extra arguments passed to `expo export`. */
  exportArgs?: string[]
  /** The manifest's `extra.expoClient`. Defaults to `expo config --type public`. */
  expoConfig?: Record<string, unknown>
  log?: (message: string) => void
}

export interface RollbackOptions extends Target {
  platform: Platform
  channel: string
  root?: string
  runtimeVersion?: string
  /** Serve this earlier update again. Without it, roll back to the embedded bundle. */
  updateId?: string
}

/** What `expo export` writes to `metadata.json`. */
interface ExportMetadata {
  fileMetadata?: Partial<
    Record<
      Platform,
      { bundle: string; assets: { path: string; ext: string }[] }
    >
  >
}

interface LocalAsset extends AssetRecord {
  file: string
}

const UPLOADS_AT_ONCE = 6

/** Exports the app for one platform and publishes it to a channel. */
export async function publish(options: PublishOptions): Promise<UpdateRecord> {
  const root = path.resolve(options.root ?? ".")
  const distDir = path.resolve(
    root,
    options.distDir ??
      path.join("node_modules", ".cache", "expoflare-updates", options.platform)
  )
  const log = options.log ?? (() => {})

  const runtimeVersion =
    options.runtimeVersion ?? resolveRuntimeVersion(root, options.platform)
  log(`Runtime version: ${runtimeVersion}`)

  if (!options.skipExport) {
    runExpo(
      root,
      [
        "export",
        "--platform",
        options.platform,
        "--output-dir",
        distDir,
        ...(options.exportArgs ?? []),
      ],
      "inherit"
    )
  }
  const { launchAsset, assets } = readExport(distDir, options.platform)
  const expoConfig = options.expoConfig ?? readExpoConfig(root)

  let uploaded = 0
  const pending = [launchAsset, ...assets]
  await Promise.all(
    Array.from({ length: UPLOADS_AT_ONCE }, async () => {
      for (let asset = pending.pop(); asset; asset = pending.pop()) {
        if (await uploadAsset(asset, options)) uploaded++
      }
    })
  )
  log(
    `Uploaded ${uploaded} of ${assets.length + 1} files (the rest were there)`
  )

  const { update } = await request<{ update: UpdateRecord }>(
    options,
    "updates",
    {
      channel: options.channel,
      platform: options.platform,
      runtimeVersion,
      message: options.message,
      launchAsset: record(launchAsset),
      assets: assets.map(record),
      extra: { expoClient: expoConfig },
    }
  )
  log(
    `Published ${update.id} to ${update.channel} (${update.platform}, runtime ${update.runtimeVersion})`
  )
  return update
}

/**
 * Points a channel back at an earlier update, or at the bundle embedded in
 * the build when no `updateId` is given.
 */
export async function rollback(options: RollbackOptions): Promise<unknown> {
  const root = path.resolve(options.root ?? ".")
  return request(options, "rollback", {
    channel: options.channel,
    platform: options.platform,
    runtimeVersion:
      options.runtimeVersion ?? resolveRuntimeVersion(root, options.platform),
    updateId: options.updateId,
  })
}

/** Reads the bundle and assets of one platform from an `expo export`. */
export function readExport(
  distDir: string,
  platform: Platform
): { launchAsset: LocalAsset; assets: LocalAsset[] } {
  const metadataPath = path.join(distDir, "metadata.json")
  if (!existsSync(metadataPath)) {
    throw new Error(
      `${metadataPath} not found. Run \`expo export --platform ${platform}\` first, or drop --skip-export.`
    )
  }
  const metadata: ExportMetadata = JSON.parse(
    readFileSync(metadataPath, "utf8")
  )
  const files = metadata.fileMetadata?.[platform]
  if (!files) {
    throw new Error(`${metadataPath} has no ${platform} export.`)
  }
  return {
    launchAsset: localAsset(
      path.join(distDir, files.bundle),
      ".bundle",
      "application/javascript"
    ),
    assets: files.assets.map((asset) =>
      localAsset(
        path.join(distDir, asset.path),
        `.${asset.ext}`,
        CONTENT_TYPES[asset.ext.toLowerCase()] ?? "application/octet-stream"
      )
    ),
  }
}

function localAsset(
  file: string,
  fileExtension: string,
  contentType: string
): LocalAsset {
  const digest = createHash("sha256").update(readFileSync(file)).digest()
  return {
    file,
    hash: digest.toString("base64url"),
    key: digest.toString("hex"),
    contentType,
    fileExtension,
  }
}

const record = ({ file: _file, ...asset }: LocalAsset): AssetRecord => asset

/** Uploads a file unless the server has it. Returns whether it uploaded. */
async function uploadAsset(asset: LocalAsset, target: Target) {
  const send = target.fetch ?? fetch
  const url = `${baseUrl(target)}/assets/${asset.hash}`
  const head = await send(url, { method: "HEAD" })
  if (head.ok) return false
  const response = await send(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${target.token}`,
      "content-type": asset.contentType,
    },
    body: readFileSync(asset.file),
  })
  if (!response.ok) await fail(response, `uploading ${asset.file}`)
  return true
}

async function request<T>(
  target: Target,
  route: string,
  body: unknown
): Promise<T> {
  const response = await (target.fetch ?? fetch)(
    `${baseUrl(target)}/${route}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  )
  if (!response.ok) await fail(response, `POST ${route}`)
  return (await response.json()) as T
}

const baseUrl = (target: Target) => target.url.replace(/\/+$/, "")

async function fail(response: Response, what: string): Promise<never> {
  const text = await response.text()
  let message = text
  try {
    message = JSON.parse(text).error ?? text
  } catch {
    // Not JSON: show the body as it came.
  }
  throw new Error(`${what} failed (${response.status}): ${message}`)
}

/** Whatever the project's `runtimeVersion` (a string or a policy) resolves to. */
function resolveRuntimeVersion(root: string, platform: Platform): string {
  let cli: string
  try {
    cli = createRequire(path.join(root, "package.json")).resolve(
      "expo-updates/bin/cli.js"
    )
  } catch {
    throw new Error(
      `Could not find \`expo-updates\` from ${root}. Install it, or pass --runtime-version.`
    )
  }
  const output = run(
    [cli, "runtimeversion:resolve", "--platform", platform],
    root
  )
  const version = parseJsonOutput(output).runtimeVersion
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "The project has no runtimeVersion. Set one in the app config, or pass --runtime-version."
    )
  }
  return version
}

function readExpoConfig(root: string): Record<string, unknown> {
  return parseJsonOutput(
    runExpo(root, ["config", "--json", "--type", "public"], "pipe")
  )
}

function runExpo(root: string, args: string[], stdout: "inherit" | "pipe") {
  let cli: string
  try {
    cli = createRequire(path.join(root, "package.json")).resolve("expo/bin/cli")
  } catch {
    throw new Error(
      `Could not find the \`expo\` package from ${root}. Is this an Expo project?`
    )
  }
  return run([cli, ...args], root, stdout)
}

function run(
  args: string[],
  cwd: string,
  stdout: "inherit" | "pipe" = "pipe"
): string {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", stdout, "inherit"],
  })
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(args[0]!)} ${args[1]} failed with exit code ${result.status}`
    )
  }
  return result.stdout ?? ""
}

/** The JSON a CLI printed, skipping any log lines before it. */
function parseJsonOutput(output: string): Record<string, unknown> {
  return JSON.parse(output.slice(output.indexOf("{")))
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  js: "application/javascript",
  html: "text/html",
  css: "text/css",
  txt: "text/plain",
  xml: "application/xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  lottie: "application/zip",
  db: "application/octet-stream",
}
