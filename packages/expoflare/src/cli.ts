#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { build } from "./build.ts"

const HELP = `expoflare: deploy Expo web exports to Cloudflare Workers

Usage
  expoflare build [options] [-- <expo export args>]

Runs \`expo export -p web\`, then writes .expoflare/ and points wrangler at it.
Afterwards, \`wrangler dev\` and \`wrangler deploy\` use the build.

Options
  --root <dir>     Expo project root (default: .)
  --dist <dir>     expo export output directory (default: dist)
  --skip-export    Package an existing export instead of running expo export
  -e, --env <name> wrangler environment to build for (default: $CLOUDFLARE_ENV)
  -h, --help       Show this help
  -v, --version    Show the version
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    dist: { type: "string" },
    "skip-export": { type: "boolean" },
    env: { type: "string", short: "e" },
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

if (command !== "build") {
  console.error(`Unknown command: ${command}\n\n${HELP}`)
  process.exit(1)
}

try {
  build({
    root: values.root,
    distDir: values.dist,
    skipExport: values["skip-export"],
    exportArgs: rest,
    env: values.env,
    log: (message) => console.log(`[expoflare] ${message}`),
  })
} catch (error) {
  console.error(`[expoflare] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
