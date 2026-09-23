import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, rm, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(root, "out/plugin/browser-verify");
await mkdir(resolve(root, "out/plugin"), { recursive: true });
const output = await mkdtemp(resolve(root, "out/plugin/.build-"));
try {
await cp(join(root, "plugins/browser-verify"), output, { recursive: true });
for (const path of ["src", "bin", "docs", "LICENSE", "package-lock.json"]) await cp(join(root, path), join(output, path), { recursive: true });
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// Same dependency graph/lock as the tested runtime. No checkout, credentials, reports or git state.
await writeFile(join(output, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
await chmod(join(output, "bin/browser-verify.mjs"), 0o755);
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: output, stdio: "inherit" });
// Replace only our generated artifact after a successful build. Stale files cannot enter a release.
await rm(destination, { recursive: true, force: true });
await rename(output, destination);
console.log(`Self-contained local plugin: ${destination}`);
} finally { await rm(output, { recursive: true, force: true }); }
