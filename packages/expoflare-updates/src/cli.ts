#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { PLATFORMS, type Platform } from "./protocol.ts"
import { publish, rollback } from "./publish.ts"

const HELP = `expoflare-updates: self-hosted Expo updates on Cloudflare Workers

Usage
  expoflare-updates publish --channel <name> --platform <ios|android|all> [options] [-- <expo export args>]
  expoflare-updates rollback --channel <name> --platform <ios|android|all> [--to <update id>] [options]

publish runs \`expo export\` for the platform, uploads what the server doesn't
have, and makes the new update what the channel serves.

rollback serves an earlier update again (--to), or sends apps back to the
bundle embedded in their build.

Options
  --url <url>               Where the handler is mounted (or EXPOFLARE_UPDATES_URL)
  --token <token>           The publish token (or EXPOFLARE_UPDATES_TOKEN)
  --runtime-version <v>     Defaults to what the project's runtimeVersion resolves to
  --message <text>          A note stored with the update
  --root <dir>              Expo project root (default: .)
  --dist <dir>              expo export output directory
  --skip-export             Publish an existing export instead of running expo export
  -h, --help                Show this help
  -v, --version             Show the version
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string" },
    platform: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    "runtime-version": { type: "string" },
    message: { type: "string" },
    to: { type: "string" },
    root: { type: "string" },
    dist: { type: "string" },
    "skip-export": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
})

if (values.version) {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  )
  console.log(pkg.version)
  process.exit(0)
}

const [command, ...rest] = positionals
if (values.help || !command) {
  console.log(HELP)
  process.exit(values.help ? 0 : 1)
}

const log = (message: string) => console.log(`[expoflare-updates] ${message}`)

try {
  if (command !== "publish" && command !== "rollback") {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`)
  }
  const target = {
    url: required(values.url ?? process.env.EXPOFLARE_UPDATES_URL, "--url"),
    token: required(
      values.token ?? process.env.EXPOFLARE_UPDATES_TOKEN,
      "--token"
    ),
    channel: required(values.channel, "--channel"),
    root: values.root,
    runtimeVersion: values["runtime-version"],
  }
  for (const platform of platforms(values.platform)) {
    if (command === "publish") {
      await publish({
        ...target,
        platform,
        distDir: values.dist,
        message: values.message,
        skipExport: values["skip-export"],
        exportArgs: rest,
        log,
      })
    } else {
      await rollback({ ...target, platform, updateId: values.to })
      log(
        values.to
          ? `${target.channel} (${platform}) serves ${values.to} again`
          : `${target.channel} (${platform}) rolls back to the embedded bundle`
      )
    }
  }
} catch (error) {
  console.error(
    `[expoflare-updates] ${error instanceof Error ? error.message : error}`
  )
  process.exit(1)
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing ${flag}.`)
  return value
}

function platforms(value: string | undefined): readonly Platform[] {
  if (value === "all") return PLATFORMS
  const platform = PLATFORMS.find((candidate) => candidate === value)
  if (!platform) throw new Error("--platform must be ios, android or all.")
  return [platform]
}
