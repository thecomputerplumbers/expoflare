import { existsSync } from "node:fs"
import path from "node:path"

/**
 * The three shapes `expo export -p web` produces, keyed off `web.output`:
 *
 * - `single`: one `index.html` plus bundles, served as a single-page app.
 * - `static`: one pre-rendered `.html` file per route.
 * - `server`: `client/` for assets and `server/` for HTML, API routes, and
 *   `_expo/routes.json`, which needs a Worker to route requests.
 */
export type OutputMode = "single" | "static" | "server"

export interface ExpoOutput {
  mode: OutputMode
  /** Directory served as static assets. */
  clientDir: string
  /** Directory uploaded as Worker modules (server mode only). */
  serverDir: string | null
}

export function detectOutput(distDir: string): ExpoOutput {
  const serverDir = path.join(distDir, "server")
  if (existsSync(path.join(serverDir, "_expo", "routes.json"))) {
    return {
      mode: "server",
      clientDir: path.join(distDir, "client"),
      serverDir,
    }
  }

  if (!existsSync(path.join(distDir, "index.html"))) {
    throw new Error(
      `No Expo web export found in ${distDir}. Run \`expo export -p web\` first, or drop --skip-export.`
    )
  }

  // Static exports always write a route manifest and a not-found page;
  // single-page exports write neither.
  const isStatic =
    existsSync(path.join(distDir, "_expo", ".routes.json")) ||
    existsSync(path.join(distDir, "+not-found.html"))
  return {
    mode: isStatic ? "static" : "single",
    clientDir: distDir,
    serverDir: null,
  }
}
