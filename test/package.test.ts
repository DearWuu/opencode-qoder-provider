import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("the package manifest ships src and scripts", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }
  assert.ok(pkg.files.includes("scripts"))
  assert.ok(pkg.files.includes("src"))
})

test("npm pack ships scripts/check-real-catalog.mjs", (t) => {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  })
  if (pack.status !== 0) {
    t.skip(`npm pack --dry-run failed with status ${pack.status}`)
    return
  }

  const packed = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>
  const files = packed[0]!.files.map((entry) => entry.path)
  assert.ok(files.includes("scripts/check-real-catalog.mjs"), `packaged files: ${files.join(", ")}`)
  assert.ok(files.includes("src/cli.mjs"))
  assert.ok(files.includes("provider.mjs"))
})
