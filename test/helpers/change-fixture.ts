import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
export const originalPricing = `export function shipping(total) {
  if (total < 0) throw new RangeError('Negative total');
  return total > 50 ? 0 : 5;
}\n`;
export const changedPricing = originalPricing.replace('total > 50', 'total >= 50');
export const weakTests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipping } from '../src/index.mjs';
test('ordinary orders', () => { assert.equal(shipping(20), 5); assert.equal(shipping(80), 0); });\n`;
export const strongTests = weakTests + `test('threshold, zero and invalid input', () => {
  assert.equal(shipping(50), 0); assert.equal(shipping(0), 5); assert.throws(() => shipping(-1), RangeError);
});\n`;
export async function changeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'vouch-change-fixture-'));
  const git = (...args: string[]) => exec('git', ['-C', root, ...args], { encoding: 'utf8' });
  await mkdir(join(root, 'src')); await mkdir(join(root, 'test'));
  await writeFile(join(root, '.gitignore'), '.env\nout/\n');
  await writeFile(join(root, '.env'), 'SECRET=must-not-enter-snapshot\n');
  await writeFile(join(root, 'src/pricing.mjs'), originalPricing);
  await writeFile(join(root, 'src/index.mjs'), "export { shipping } from './pricing.mjs';\n");
  await writeFile(join(root, 'test/pricing.test.mjs'), weakTests);
  await writeFile(join(root, 'vouch.config.json'), JSON.stringify({ testCommand: ['node', '--test', 'test/pricing.test.mjs'], commandTimeoutMs: 2000, totalTimeoutMs: 30000, maxMutants: 10 }));
  await git('init', '--quiet'); await git('add', '.');
  await git('-c', 'user.name=Vouch Test', '-c', 'user.email=vouch-test@example.invalid', 'commit', '-qm', 'Base fixture');
  await writeFile(join(root, 'src/pricing.mjs'), changedPricing);
  return { root, git, close: () => rm(root, { recursive: true, force: true }) };
}
