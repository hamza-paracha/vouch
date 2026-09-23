import ts from "typescript-ast";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { codeFile, testFile, snapshotRepository, type RepositorySnapshot } from "./repository.ts";
import { changeInputSchema, type ChangePlan, type Mutation } from "./schema.ts";

function importedFile(file: string, specifier: string, files: Map<string, Buffer>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(file), specifier));
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  return [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((ext) => [base + ext, stem + ext, `${base}/index${ext}`])].find((p) => files.has(p));
}
const swapped: Record<string, string> = { ">": ">=", ">=": ">", "<": "<=", "<=": "<", "===": "!==", "!==": "===", "==": "!=", "!=": "==", "&&": "||", "||": "&&", "+": "-", "-": "+", "*": "/", "/": "*" };
function functionName(node: ts.Node): string {
  if ("name" in node && node.name && ts.isIdentifier(node.name as ts.Node)) return (node.name as ts.Identifier).text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}
const callable = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);

export function analyzeSnapshot(snapshot: RepositorySnapshot): ChangePlan {
  const plan: ChangePlan = { schemaVersion: 1, baseCommit: snapshot.baseCommit, snapshotHash: snapshot.hash,
    changedFiles: snapshot.changes, changedSymbols: [], affectedFiles: [], affectedTests: [], unresolvedImports: [], mutations: [], candidateCount: 0, gaps: [],
    limitations: [...snapshot.warnings, "Static import reachability is not runtime test coverage.", "Mutations challenge specific behaviors; survival may indicate missing assertions or an equivalent change.", "Dynamic resolution, external packages, reflection and non-JavaScript/TypeScript code are not fully analyzed."] };
  const reverse = new Map<string, Set<string>>();
  const sources = new Map<string, ts.SourceFile>();
  for (const [file, buffer] of snapshot.files) {
    if (!codeFile.test(file)) continue;
    const source = ts.createSourceFile(file, buffer.toString("utf8"), ts.ScriptTarget.Latest, true);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length) plan.limitations.push(`Skipped mutations for ${file}: syntax could not be parsed with the supported TypeScript parser.`);
    else sources.set(file, source);
    const visit = (node: ts.Node) => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (specifier) {
        const resolved = importedFile(file, specifier, snapshot.files);
        if (resolved) { const dependents = reverse.get(resolved) ?? new Set(); dependents.add(file); reverse.set(resolved, dependents); }
        else if (specifier.startsWith(".") || specifier.startsWith("@/")) plan.unresolvedImports.push(`${file}: ${specifier}`);
      }
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  const affected = new Set(snapshot.changes.map((c) => c.path)); const queue = [...affected];
  while (queue.length) for (const file of reverse.get(queue.shift()!) ?? []) if (!affected.has(file)) { affected.add(file); queue.push(file); }
  plan.affectedFiles = [...affected].sort(); plan.affectedTests = plan.affectedFiles.filter((f) => testFile.test(f) && snapshot.files.has(f));
  if (!snapshot.changes.length) plan.gaps.push("No changes against the selected base. Choose the commit before the change you want to verify.");
  if (!plan.affectedTests.length) plan.gaps.push("No tests reachable from changed files through supported static imports. Run a configured full suite and add focused regression tests.");
  for (const change of snapshot.changes) {
    const source = sources.get(change.path); if (!source || testFile.test(change.path)) continue;
    const intersects = (node: ts.Node) => {
      const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const last = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      return change.ranges.some((r) => r.start <= last && r.end >= first);
    };
    const changedFunctions: ts.Node[] = [];
    const find = (node: ts.Node) => { if (callable(node) && intersects(node)) { changedFunctions.push(node); plan.changedSymbols.push({ file: change.path, name: functionName(node), startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1 }); } ts.forEachChild(node, find); }; find(source);
    const add = (node: ts.Node, after: string, kind: string, suggestedTest: string) => {
      const start = node.getStart(source), end = node.getEnd();
      const enclosing = changedFunctions.filter((f) => start >= f.getStart(source) && end <= f.getEnd()).at(-1);
      if (!intersects(node) && !enclosing) return;
      const before = source.text.slice(start, end); if (before === after || before.length > 1500) return;
      const location = source.getLineAndCharacterOfPosition(start);
      const id = createHash("sha256").update(`${change.path}:${start}:${after}`).digest("hex").slice(0, 12);
      plan.mutations.push({ id, file: change.path, line: location.line + 1, column: location.character + 1, start, end, before, after, kind, symbol: enclosing ? functionName(enclosing) : "<module>", suggestedTest });
    };
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.getText(source); const replacement = swapped[op];
        if (replacement) add(node.operatorToken, replacement, /[<>]/.test(op) ? "boundary" : ["&&", "||"].includes(op) ? "logical" : ["+", "-", "*", "/"].includes(op) ? "arithmetic" : "equality", /[<>]/.test(op) ? `Exercise equality at the threshold in ${node.getText(source).slice(0, 160)}, plus values on both sides.` : `Add an assertion that distinguishes ${node.getText(source).slice(0, 160)} when ${op} becomes ${replacement}.`);
      }
      if (ts.isIfStatement(node) && !node.elseStatement) {
        const throws = ts.isThrowStatement(node.thenStatement) || ts.isBlock(node.thenStatement) && node.thenStatement.statements.some(ts.isThrowStatement);
        if (throws) add(node.expression, "false", "guard-removal", `Exercise the invalid input rejected by ${node.expression.getText(source).slice(0, 160)} and assert the error.`);
      }
      if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) add(node, node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true", "boolean", "Assert both boolean outcomes through the public behavior.");
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  plan.mutations = [...new Map(plan.mutations.map((m) => [m.id, m])).values()];
  plan.candidateCount = plan.mutations.length;
  if (!plan.candidateCount) plan.gaps.push("No supported behavioral mutations in the changed code. This run cannot establish test sensitivity for the change.");
  if (plan.changedFiles.some((f) => f.status === "deleted")) plan.gaps.push("Deleted code has no current body to mutate; review its dependents and removed behavior explicitly.");
  // Bound MCP output on large diffs; preserve the total so omission is visible.
  plan.mutations = plan.mutations.slice(0, 200);
  return plan;
}
export async function analyzeChange(raw: unknown, projectRoot: string, signal?: AbortSignal) {
  const input = changeInputSchema.parse(raw);
  return analyzeSnapshot(await snapshotRepository(projectRoot, input.base, signal));
}
