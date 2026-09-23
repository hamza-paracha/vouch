import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, rm, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, "out"), { recursive: true });
const output = await mkdtemp(join(root, "out/.review-package-"));
const destination = join(root, "out/review-package");
try {
  const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await mkdir(join(output, "bin")); await mkdir(join(output, "src/verify"), { recursive: true });
  await cp(join(root, "src/review"), join(output, "src/review"), { recursive: true });
  for (const file of ["routing.ts", "ledger.ts", "redact.ts", "schema.ts"]) await cp(join(root, "src/verify", file), join(output, "src/verify", file));
  await cp(join(root, "bin/guard.mjs"), join(output, "bin/guard.mjs")); await chmod(join(output, "bin/guard.mjs"), 0o755);
  await cp(join(root, "LICENSE"), join(output, "LICENSE"));
  await cp(join(root, "docs/structured-review.md"), join(output, "README.md"));
  await writeFile(join(output, "package.json"), JSON.stringify({ name: "vouch-guard", version: source.version, private: true, type: "module",
    description: "Jev structured diff review for coding agents. No browser or code execution.", license: source.license, repository: source.repository,
    engines: source.engines, bin: { "vouch-guard": "bin/guard.mjs" }, files: ["bin", "src", "README.md", "LICENSE"],
    dependencies: Object.fromEntries(["@modelcontextprotocol/sdk", "@typesafe-ai/sdk", "tsx", "zod"].map(name => [name, source.dependencies[name]])),
  }, null, 2) + "\n");
  // Seed exact resolved versions from Vouch's tested lock rather than resolving a new dependency graph.
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  lock.name = pkg.name; lock.version = pkg.version; lock.packages[""] = { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, bin: pkg.bin, engines: pkg.engines, license: pkg.license };
  await writeFile(join(output, "package-lock.json"), JSON.stringify(lock, null, 2));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: output, stdio: "pipe" });
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: output, stdio: "pipe" });
  execFileSync(process.execPath, [join(output, "bin/guard.mjs"), "--help"], { cwd: output, stdio: "pipe" });
  await rm(destination, { recursive: true, force: true }); await rename(output, destination);
  console.log(`Standalone code-review package: ${destination}`);
} finally { await rm(output, { recursive: true, force: true }); }
