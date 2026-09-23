import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile, writeFile, mkdir, symlink, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { changeFixture, changedPricing, strongTests } from './helpers/change-fixture.ts';
import { analyzeChange } from '../src/change/analyze.ts';
import { snapshotRepository } from '../src/change/repository.ts';
import { verifyChange, mutationPatch } from '../src/change/verify.ts';
import { runCommand } from '../src/change/process.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('AST analysis follows transitive imports and proposes boundary/guard challenges for changed functions', async () => {
  const fixture = await changeFixture();
  try {
    const plan = await analyzeChange({ base: 'HEAD' }, fixture.root);
    assert.deepEqual(plan.affectedTests, ['test/pricing.test.mjs']);
    assert.ok(plan.affectedFiles.includes('src/index.mjs'));
    assert.ok(plan.changedSymbols.some(s => s.name === 'shipping'));
    assert.ok(plan.mutations.some(m => m.kind === 'guard-removal'));
    assert.ok(plan.mutations.some(m => m.before === '>=' && m.after === '>'));
    assert.ok(!plan.changedFiles.some(f => f.path === '.env'));
  } finally { await fixture.close(); }
});

it('mutation evidence exposes weak tests, then detects every sampled mutation after targeted regression tests', async () => {
  const fixture = await changeFixture();
  try {
    const options = { projectRoot: fixture.root, allowExecution: true, outputDir: join(fixture.root,'out') };
    const before = await readFile(join(fixture.root,'src/pricing.mjs'));
    const weak = await verifyChange({ base: 'HEAD', confirmCodeExecution: true }, options);
    assert.equal(weak.status, 'gaps_found', weak.reason); assert.equal(weak.baseline.length, 2); assert.ok(weak.summary.survived >= 1);
    assert.ok(weak.mutations.some(m => m.mutation.kind === 'boundary' && m.outcome === 'survived'));
    for (const m of weak.mutations) await fixture.git('apply', '--check', m.patch);
    assert.ok((await readFile(join(fixture.root,'src/pricing.mjs'))).equals(before), 'No mutation may touch the original checkout');
    await writeFile(join(fixture.root,'test/pricing.test.mjs'), strongTests);
    const strong = await verifyChange({ base: 'HEAD', confirmCodeExecution: true }, options);
    assert.equal(strong.status, 'evidence_collected', JSON.stringify(strong));
    assert.equal(strong.summary.survived, 0); assert.equal(strong.summary.detected, strong.summary.tested); assert.equal(strong.summary.tested, 3);
    assert.equal(strong.finalBaseline?.outcome, 'passed');
    assert.ok(strong.mutations.every(m => m.runs.length === 2 && m.runs.every(r => r.outcome === 'failed')));
    assert.equal(await readFile(join(fixture.root,'src/pricing.mjs'),'utf8'), changedPricing);
    assert.match(await readFile(strong.artifacts.markdown,'utf8'), /not proof/);
  } finally { await fixture.close(); }
});

it('a failing baseline cannot be advertised as successful mutation detection', async () => {
  const fixture = await changeFixture();
  try {
    await writeFile(join(fixture.root,'test/pricing.test.mjs'), "import assert from 'node:assert/strict'; assert.fail('Existing failure');");
    const r = await verifyChange({ confirmCodeExecution: true }, { projectRoot: fixture.root, allowExecution: true, outputDir: join(fixture.root,'out') });
    assert.equal(r.status, 'baseline_failed'); assert.equal(r.mutations.length, 0);
  } finally { await fixture.close(); }
});

it('execution must be operator enabled; caller input cannot supply arbitrary commands', async () => {
  const fixture = await changeFixture();
  try {
    await assert.rejects(verifyChange({ confirmCodeExecution: true }, { projectRoot: fixture.root }), /disabled/);
    await assert.rejects(verifyChange({ confirmCodeExecution: true, testCommand: ['node','-e','process.exit()'] }, { projectRoot: fixture.root, allowExecution: true }), /Unrecognized/);
  } finally { await fixture.close(); }
});

it('snapshot contains working changes but excludes credentials and external symlinks', async () => {
  const fixture = await changeFixture();
  try {
    await writeFile(join(fixture.root,'src/new.mjs'), 'export const enabled = true;');
    await symlink(join(fixture.root,'.env'), join(fixture.root,'src/leak.mjs'));
    const snapshot = await snapshotRepository(fixture.root, 'HEAD');
    assert.ok(snapshot.files.has('src/new.mjs')); assert.ok(!snapshot.files.has('.env')); assert.ok(!snapshot.files.has('src/leak.mjs'));
    assert.ok(snapshot.changes.some(c => c.path === 'src/new.mjs' && c.status === 'added'));
    assert.ok(snapshot.warnings.some(w => w.includes('leak.mjs')));
  } finally { await fixture.close(); }
});

it('process runner enforces timeout, cancellation and output limits without forwarding credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(),'vouch-process-'));
  const controller = new AbortController();
  const previous = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic-should-not-be-forwarded';
  try {
    const safe = await runCommand(['node','-e',"console.log(Boolean(process.env.TYPESAFE_API_KEY))"], directory, 2000, controller.signal);
    assert.equal(safe.outcome, 'passed'); assert.equal(safe.stdout.trim(), 'false');
    const hung = await runCommand(['node','-e','setInterval(()=>{}, 1000)'], directory, 200, controller.signal); assert.equal(hung.outcome, 'timed_out');
    const noisy = await runCommand(['node','-e',"process.stdout.write('x'.repeat(200000))"], directory, 2000, controller.signal); assert.equal(noisy.outcome, 'output_limit'); assert.ok(noisy.stdout.length <= 128000);
    controller.abort(); assert.equal((await runCommand(['node','-e','process.exit(0)'], directory, 2000, controller.signal)).outcome, 'cancelled');
  } finally { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; await rm(directory,{recursive:true,force:true}); }
});

it('real MCP transport exposes code analysis and returns mutation gaps with local evidence', async () => {
  const fixture = await changeFixture();
  const client = new Client({name:'change-test',version:'1'});
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args:[resolve('bin/vouch.mjs'),'--stdio'],
      env:{PATH:process.env.PATH ?? '',HOME:process.env.HOME ?? '',VOUCH_PROJECT_ROOT:fixture.root,VOUCH_ALLOW_EXECUTION:'1',VERIFY_OUTPUT_DIR:join(fixture.root,'out')},stderr:'pipe' }));
    const plan = await client.callTool({name:'analyze_change',arguments:{base:'HEAD'}}); assert.notEqual(plan.isError,true); assert.ok(JSON.stringify(plan.structuredContent).includes('shipping'));
    const result = await client.callTool({name:'verify_change',arguments:{base:'HEAD',confirmCodeExecution:true}},undefined,{timeout:60000});
    assert.equal(result.isError,true); assert.equal((result.structuredContent as Record<string, unknown>)?.status,'gaps_found');
    assert.ok(JSON.stringify(result.structuredContent).includes('suggestedTest')); assert.ok(!JSON.stringify(result.structuredContent).includes('stdout'));
  } finally { await client.close(); await fixture.close(); }
});


it('unstable baselines stop mutation attribution; invalid mutants never count as detected', async () => {
  const fixture = await changeFixture();
  const external = await mkdtemp(join(tmpdir(), 'vouch-baseline-state-'));
  const configPath = join(fixture.root, 'vouch.config.json');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const counter = join(external, 'counter');
    await writeFile(join(fixture.root, 'test/pricing.test.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
      const path = ${JSON.stringify(counter)}; if (existsSync(path)) process.exit(1); writeFileSync(path, 'seen');`);
    const options = { projectRoot: fixture.root, allowExecution: true, outputDir: join(fixture.root, 'out') };
    const unstable = await verifyChange({ confirmCodeExecution: true }, options);
    assert.equal(unstable.status, 'inconclusive'); assert.equal(unstable.baseline.length, 2); assert.equal(unstable.mutations.length, 0);
    await writeFile(join(fixture.root, 'test/pricing.test.mjs'), strongTests);
    // The project's validator rejects every candidate; those failures are not test detections.
    config.validationCommand = ['node', '-e', `const fs = require('node:fs'); process.exit(fs.readFileSync('src/pricing.mjs','utf8') === ${JSON.stringify(changedPricing)} ? 0 : 1)`];
    await writeFile(configPath, JSON.stringify(config));
    const invalid = await verifyChange({ confirmCodeExecution: true }, options);
    assert.equal(invalid.status, 'inconclusive'); assert.equal(invalid.summary.invalid, 3); assert.equal(invalid.summary.detected, 0);
  } finally { await fixture.close(); await rm(external, { recursive: true, force: true }); }
});

it('exact patches apply to filenames with spaces, CRLF and missing terminal newlines', async () => {
  const fixture = await changeFixture();
  try {
    for (const source of ['export const value = 1 + 2;', 'const first = 0;\r\nexport const value = 1 + 2;\r\n']) {
      const file = 'src/spaced name.mjs'; const start = source.indexOf('+');
      const m = { id:'patch-test', file, start, end:start+1, before:'+', after:'-', kind:'arithmetic', line:source.slice(0,start).split('\n').length, column:1, symbol:'value', suggestedTest:'' };
      await writeFile(join(fixture.root,file), source);
      const patch = join(fixture.root, 'patch.diff'); await writeFile(patch, mutationPatch(m,source));
      await fixture.git('apply', patch);
      assert.equal(await readFile(join(fixture.root,file),'utf8'), source.replace('+','-'));
    }
  } finally { await fixture.close(); }
});

it('disposable snapshots preserve executable test scripts', { skip: process.platform === 'win32' }, async () => {
  const fixture = await changeFixture();
  try {
    const executable = join(fixture.root,'check');
    await writeFile(executable, '#!/bin/sh\nexec node --test test/pricing.test.mjs\n'); await chmod(executable, 0o755);
    const configPath = join(fixture.root,'vouch.config.json'); const config = JSON.parse(await readFile(configPath,'utf8'));
    config.testCommand = ['./check']; await writeFile(configPath,JSON.stringify(config));
    const report = await verifyChange({ confirmCodeExecution: true }, { projectRoot:fixture.root, allowExecution:true, outputDir:join(fixture.root,'out') });
    assert.equal(report.status,'gaps_found', report.reason);
  } finally { await fixture.close(); }
});
