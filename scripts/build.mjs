import { chmodSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = join(root, "dist");
if (dirname(output) !== root) throw new Error("Invalid build output directory");
rmSync(output, { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(join(output, "cli/index.js"), 0o755);
