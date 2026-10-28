// backend/test-utils/provider-branch-scan.ts
import ts from 'typescript';
import fs from 'fs';
import path from 'path';

export interface Hit { line: number; text: string }
export interface TreeHit extends Hit { file: string }

const LOOKUP_METHODS = new Set(['includes', 'has', 'indexOf', 'lastIndexOf']);
// Directories and files that exist only to support tests; they may name providers freely.
const TEST_SUPPORT_DIRS = new Set(['__tests__', 'test-utils']);
const TEST_SUPPORT_FILE = /^test-helpers\.tsx?$/;

export function scanSource(fileName: string, text: string, ids: readonly string[]): Hit[] {
  const idSet = new Set(ids);
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];

  // Peel wrappers that do not change the runtime value: `('x' as string)`,
  // `<string>'x'`, `'x' satisfies string`, `x!`, `(x)`.
  const unwrap = (n: ts.Node): ts.Node => {
    let cur = n;
    while (
      ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)
    ) cur = cur.expression;
    return cur;
  };
  const isIdLiteral = (n: ts.Node): boolean => {
    const u = unwrap(n);
    return (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) && idSet.has(u.text);
  };
  // An array literal of ids, or `new Set([...ids])`, as the receiver of a lookup.
  const holdsIdLiteral = (target: ts.Node): boolean => {
    const list = ts.isNewExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Set'
      ? target.arguments?.[0] && unwrap(target.arguments[0])
      : target;
    return !!list && ts.isArrayLiteralExpression(list) && list.elements.some(isIdLiteral);
  };
  const hasIdKey = (p: ts.ObjectLiteralElementLike): boolean => {
    const name = p.name;
    if (!name) return false;
    if (ts.isIdentifier(name)) return idSet.has(name.text);
    if (ts.isComputedPropertyName(name)) return isIdLiteral(name.expression);
    return (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) && idSet.has(name.text);
  };
  // `at` fixes the reported line; `shown` is the node whose source is reported.
  const add = (at: ts.Node, shown: ts.Node = at) => {
    const { line } = sf.getLineAndCharacterOfPosition(at.getStart(sf));
    hits.push({ line: line + 1, text: shown.getText(sf).slice(0, 80) });
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCaseClause(n) && isIdLiteral(n.expression)) add(n, n.expression);
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
         op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (isIdLiteral(n.left) || isIdLiteral(n.right))
      ) add(n);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && LOOKUP_METHODS.has(n.expression.name.text)) {
      const argHit = n.arguments.some(isIdLiteral);
      if (argHit || holdsIdLiteral(unwrap(n.expression.expression))) add(n);
    }
    if (ts.isElementAccessExpression(n)) {
      const target = unwrap(n.expression);
      if (isIdLiteral(n.argumentExpression) || (ts.isObjectLiteralExpression(target) && target.properties.some(hasIdKey))) add(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

export function scanTree(
  root: string,
  ids: readonly string[],
  allow: (relPath: string) => boolean,
): TreeHit[] {
  const out: TreeHit[] = [];
  const idRe = new RegExp(ids.map((i) => i.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'));
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!TEST_SUPPORT_DIRS.has(ent.name)) walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(ent.name) || /\.(test|spec)\.tsx?$/.test(ent.name) || ent.name.endsWith('.d.ts')) continue;
      if (TEST_SUPPORT_FILE.test(ent.name)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (allow(rel)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!idRe.test(text)) continue; // cheap prefilter before parsing
      for (const h of scanSource(full, text, ids)) out.push({ file: rel, ...h });
    }
  };
  walk(root);
  return out;
}

export function formatHits(hits: readonly TreeHit[]): string {
  if (hits.length === 0) return '';
  return [
    'Provider ids are compared outside the catalog and the dialects. Move each one into a catalog field or a dialect (see docs/ai-providers.md):',
    ...hits.map((h) => `  ${h.file}:${h.line} ${h.text}`),
  ].join('\n');
}
