import assert from 'node:assert/strict';
import { it } from 'node:test';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { changeFixture } from './helpers/change-fixture.ts';
import { getDiff } from '../src/review/diff.ts';
import { fileRequest, fileQuestions, prQuestions, MAX_STATE_BYTES, type ReviewRequest } from '../src/review/questions.ts';
import { decodeJudgment, type ReviewAdapter } from '../src/review/judge.ts';
import { reviewCode } from '../src/review/review.ts';
import { ModelBudget } from '../src/verify/routing.ts';
import { reviewOptionsFromEnv } from '../src/review/config.ts';
import type { Questions } from '@typesafe-ai/sdk';

function response(questions: Questions) {
  return { model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 20 }, answers: Object.fromEntries(Object.entries(questions).map(([key,q]) => {
    if (q.type === 'noul') return [key, { type:'noul', noul: key === 'ready_to_merge' ? 0.99 : 0.01 }];
    if (q.type === 'choice') { const keys = Object.keys(q.criteria); return [key, { type:'choice', choice:keys[0], confidence:0.99, probabilities:Object.fromEntries(keys.map((k,i) => [k,i === 0 ? 1 : 0])) }]; }
    return [key, { type:'score', score:0, confidence:0.99, probabilities:Object.fromEntries(q.criteria.map((_,i) => [i,i === 0 ? 1 : 0])), legend:Object.fromEntries(q.criteria.map((text,i) => [i,text])) }];
  })) };
}
const cleanAdapter: ReviewAdapter = { model:'jev-1.13.0', judge: async request => response(request.questions) };
const budget = () => new ModelBudget(20, 1, 0.01);

it('review diff handles working changes, staged renames, deletions and literal paths without reading excluded files', async () => {
  const f = await changeFixture();
  try {
    await f.git('mv','src/index.mjs','src/renamed module.mjs'); await f.git('rm','test/pricing.test.mjs');
    await writeFile(join(f.root,'src/new.py'),'def enabled():\n  return True\n');
    await writeFile(join(f.root,'src/binary.bin'),Buffer.from([1,0,2]));
    await writeFile(join(f.root,'src/huge.ts'),'a'.repeat(100001));
    await symlink(join(f.root,'.env'),join(f.root,'src/linked.ts'));
    await symlink(join(f.root,'missing-target'),join(f.root,'src/dangling.ts'));
    await writeFile(join(f.root,':(glob)*.ts'),'export const value = true;');
    const diff = await getDiff(f.root,'HEAD');
    assert.ok(diff.chunks.some(c => c.file === 'src/pricing.mjs' && c.additions.includes('>= 50') && c.deletions.includes('> 50')));
    assert.ok(diff.chunks.some(c => c.status === 'renamed' && c.previousFile === 'src/index.mjs'));
    assert.ok(diff.chunks.some(c => c.status === 'deleted' && c.file === 'test/pricing.test.mjs'));
    assert.ok(diff.chunks.some(c => c.language === 'python' && c.status === 'added'));
    for (const name of ['binary.bin','huge.ts','linked.ts','dangling.ts']) assert.ok(diff.skipped.some(s => s.file.endsWith(name)));
    assert.ok(!JSON.stringify(diff).includes('must-not-enter-snapshot'));
    const literal = await getDiff(f.root,'HEAD',undefined,[':(glob)*.ts']); assert.equal(literal.chunks.length,1); assert.equal(literal.chunks[0]!.file,':(glob)*.ts');
    await assert.rejects(getDiff(f.root,'HEAD',undefined,['../outside']), /relative/);
  } finally { await f.close(); }
});

it('question context stays bounded and scrubs source secrets without corrupting quoted JSON or mutating diff data', async () => {
  const f = await changeFixture(); const previous = process.env.TYPESAFE_API_KEY;
  try {
    process.env.TYPESAFE_API_KEY = 'synthetic"\\private-key';
    await writeFile(join(f.root,'src/secret.ts'), 'const password = "literal-secret";\n' + 'const notes = "' + process.env.TYPESAFE_API_KEY + '";\n' + 'export const x = true;\n'.repeat(2000));
    const chunk = (await getDiff(f.root,'HEAD',undefined,['src/secret.ts'])).chunks[0]!;
    const original = JSON.stringify(chunk); const request = fileRequest(chunk); const serialized = JSON.stringify(request.state);
    assert.ok(Buffer.byteLength(serialized) <= MAX_STATE_BYTES); assert.equal(request.truncated,true);
    assert.ok(!serialized.includes('literal-secret')); assert.ok(!serialized.includes('private-key')); assert.ok(serialized.includes('REDACTED'));
    assert.doesNotThrow(() => JSON.parse(serialized)); assert.equal(JSON.stringify(chunk),original);
    assert.equal(Object.keys(request.questions).length,8); assert.equal(Object.keys(prQuestions()).length,4);
    // Redaction may expand short secret values in hunk labels; bound the final serialized state.
    const labels = { ...chunk, additions: '', deletions: '', context: '', functions: Array(30).fill('token = "a"; '.repeat(10)), truncated: false };
    assert.ok(Buffer.byteLength(JSON.stringify(fileRequest(labels).state)) <= MAX_STATE_BYTES);
  } finally { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; await f.close(); }
});

it('judgments use real noul/score shapes and preserve uncertainty rather than declaring a clean review', () => {
  const questions = fileQuestions(), raw = response(questions);
  raw.answers.needs_tests = {type:'noul',noul:0.95}; raw.answers.needs_validation = {type:'noul',noul:0.8}; raw.answers.needs_error_handling = {type:'noul',noul:0.52};
  const result = decodeJudgment(raw,questions,{high:0.9,medium:0.7});
  assert.ok(result.flags.includes('needs_tests')); assert.ok(result.warnings.includes('needs_validation')); assert.ok(result.uncertain.includes('needs_error_handling'));
  assert.equal(result.verdicts.breaking_change!.confidence,0.99); assert.equal(result.verdicts.breaking_change!.answer,false);
  assert.equal(result.verdicts.risk_level!.answer,0);
  const broken = structuredClone(raw); delete broken.answers.ready_to_merge; assert.throws(() => decodeJudgment(broken,questions,{high:0.9,medium:0.7}),/missing/);
  broken.answers.ready_to_merge = {type:'noul',noul:NaN}; assert.throws(() => decodeJudgment(broken,questions,{high:0.9,medium:0.7}));
});

it('ten-file review executes bounded parallel requests with one call per file and measured cost', async () => {
  const f = await changeFixture(); let active = 0, peak = 0, calls = 0;
  try {
    for (let i=0;i<9;i++) await writeFile(join(f.root,`src/new-${i}.mjs`),'export const enabled = true;');
    const adapter: ReviewAdapter = {model:'jev-1.13.0', judge: async request => { calls++; active++; peak=Math.max(peak,active); await delay(40); active--; return response(request.questions); }};
    const report = await reviewCode('review_change',{base:'HEAD'},{projectRoot:f.root,outputDir:join(f.root,'out'),adapter,budget:budget(),concurrency:5});
    assert.equal(report.status,'clean',report.summary); assert.equal(calls,10); assert.equal(peak,5);
    assert.equal(report.cost.totalInputTokens,10000); assert.equal(report.cost.totalEstimatedUsd,0.00042); assert.equal(report.totals.filesReviewed,10);
    assert.equal(JSON.parse(await readFile(report.artifacts.report,'utf8')).status,'clean');
  } finally { await f.close(); }
});

it('partial context and uncertain answers require attention; provider errors and exhausted budgets cannot pass', async () => {
  const f = await changeFixture(); let calls=0;
  try {
    const options = {projectRoot:f.root,outputDir:join(f.root,'out')};
    const uncertain: ReviewAdapter = {model:'jev-1.13.0',judge:async request => {const raw=response(request.questions);raw.answers.needs_tests={type:'noul',noul:0.51};return raw;}};
    assert.equal((await reviewCode('check_file',{file:'src/pricing.mjs'},{...options,adapter:uncertain,budget:budget()})).status,'needs_attention');
    await writeFile(join(f.root,'src/large.mjs'),'export const x = true;\n'.repeat(2000));
    const partial = await reviewCode('check_file',{file:'src/large.mjs'},{...options,adapter:cleanAdapter,budget:budget()});
    assert.equal(partial.status,'needs_attention');assert.equal(partial.incomplete,true);
    const failed = await reviewCode('check_file',{file:'src/pricing.mjs'},{...options,adapter:{model:'test',judge:async()=>{calls++;throw new Error('private-provider-body');}},budget:budget()});
    assert.equal(failed.status,'error');assert.equal(calls,1);assert.equal(failed.cost.totalInputTokens,null);assert.ok(!JSON.stringify(failed).includes('private-provider-body'));
    const exhausted = await reviewCode('check_file',{file:'src/pricing.mjs'},{...options,adapter:cleanAdapter,budget:new ModelBudget()});
    assert.equal(exhausted.status,'budget_exhausted');assert.equal(exhausted.cost.totalCalls,0);
    const disabled = await reviewCode('check_file',{file:'src/pricing.mjs'},options); assert.equal(disabled.status,'error');assert.equal(disabled.cost.totalCalls,0);
    const alternate = await reviewCode('check_file',{file:'src/pricing.mjs'},{...options,budget:budget(),adapter:{model:'jev-1.13.0',judge:async request=>({...response(request.questions),model:'different-model'})}});
    assert.equal(alternate.cost.totalInputTokens,1000);assert.equal(alternate.cost.totalEstimatedUsd,null);assert.equal(alternate.cost.inputPricePerMillion,null);
    assert.throws(()=>reviewOptionsFromEnv({JEV_GUARD_MAX_CALLS:'2',TYPESAFE_API_KEY:'test'}),/LEDGER/);
  } finally { await f.close(); }
});

it('real MCP transport exposes all three review tools; SDK failures are not retried and do not crash the server', async () => {
  const f = await changeFixture(); let calls=0, fail=false;
  const api=createServer(async(req,res)=>{calls++;let body='';for await(const chunk of req)body+=chunk;
    if(fail){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"synthetic failure"}');return;}
    const request=JSON.parse(body) as ReviewRequest;res.setHeader('content-type','application/json');res.end(JSON.stringify(response(request.questions)));
  });
  api.listen(0,'127.0.0.1');await once(api,'listening');const address=api.address();if(!address||typeof address==='string')throw new Error('No port');
  const client = new Client({name:'review-integration',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('bin/vouch.mjs'),'--stdio'],stderr:'pipe',env:{
      PATH:process.env.PATH??'',HOME:process.env.HOME??'',TYPESAFE_API_KEY:'synthetic-api-key',TYPESAFE_BASE_URL:`http://127.0.0.1:${address.port}`,
      JEV_GUARD_PROJECT_ROOT:f.root,JEV_GUARD_MAX_CALLS:'10',JEV_GUARD_MAX_ESTIMATED_USD:'1',JEV_GUARD_ESTIMATE_PER_CALL_USD:'0.01',JEV_GUARD_BUDGET_LEDGER:join(f.root,'out/ledger.json'),VERIFY_OUTPUT_DIR:join(f.root,'out/reports') }}));
    assert.equal((await client.listTools()).tools.length,7);
    for(const [name,args] of [['review_change',{base:'HEAD'}],['assess_pr',{base:'HEAD',title:'Threshold fix'}],['check_file',{file:'src/pricing.mjs'}]] as const){
      const result=await client.callTool({name,arguments:args});assert.equal(result.isError,false,JSON.stringify(result));assert.equal((result.structuredContent as Record<string,unknown>).status,'clean');
    }
    assert.equal(calls,4);fail=true;
    const failed=await client.callTool({name:'check_file',arguments:{file:'src/pricing.mjs'}});assert.equal(failed.isError,true);assert.equal(calls,5);
    fail=false;const recovered=await client.callTool({name:'check_file',arguments:{file:'src/pricing.mjs'}});assert.equal(recovered.isError,false);assert.equal(calls,6);
    const invalid=await client.callTool({name:'check_file',arguments:{file:'../../.env'}});assert.equal(invalid.isError,true);assert.equal(calls,6);
    assert.equal(JSON.parse(await readFile(join(f.root,'out/ledger.json'),'utf8')).calls,6);
  } finally { await client.close();api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));await f.close(); }
});

it('review cancellation aborts an in-flight adapter and never returns clean or refunds its reservation', async () => {
  const f = await changeFixture(); const controller = new AbortController(); const limits = budget();
  let started = false;
  try {
    const adapter: ReviewAdapter = { model:'jev-1.13.0', judge:async (_request, signal) => {
      started = true; queueMicrotask(() => controller.abort());
      await delay(10000,undefined,{signal}); throw new Error('unreachable');
    }};
    const report = await reviewCode('check_file',{file:'src/pricing.mjs'},{projectRoot:f.root,outputDir:join(f.root,'out'),adapter,budget:limits,signal:controller.signal});
    assert.equal(started,true);assert.equal(report.status,'cancelled');assert.equal(limits.usedCalls,1);assert.equal(report.cost.totalInputTokens,null);
  } finally { await f.close(); }
});

it('file count limits and per-review budgets make omitted evidence visible', async () => {
  const f = await changeFixture();
  try {
    for(let i=0;i<52;i++) await writeFile(join(f.root,`src/add-${String(i).padStart(2,'0')}.mjs`),'export const x = true;');
    const diff = await getDiff(f.root,'HEAD'); assert.equal(diff.chunks.length,50);assert.equal(diff.skipped.length,3);assert.equal(diff.truncated,true);
    const report = await reviewCode('review_change',{base:'HEAD'},{projectRoot:f.root,outputDir:join(f.root,'out'),adapter:cleanAdapter,budget:budget(),maxCallsPerRun:2});
    assert.equal(report.status,'budget_exhausted');assert.equal(report.cost.totalCalls,2);assert.equal(report.totals.filesReviewed,2);assert.equal(report.incomplete,true);
  } finally { await f.close(); }
});
