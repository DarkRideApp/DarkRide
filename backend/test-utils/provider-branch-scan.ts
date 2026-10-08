// backend/test-utils/provider-branch-scan.ts
import ts from 'typescript';
import fs from 'fs';
import path from 'path';

export interface Hit { line: number; text: string }

export function scanSource(fileName: string, text: string, ids: readonly string[]): Hit[] {
  const idSet = new Set(ids);
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits: Hit[] = [];

  const isIdLiteral = (n: ts.Node): boolean =>
    (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && idSet.has(n.text);
  const add = (n: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    hits.push({ line: line + 1, text: n.getText(sf).slice(0, 80) });
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCaseClause(n) && isIdLiteral(n.expression)) add(n);
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
         op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (isIdLiteral(n.left) || isIdLiteral(n.right))
      ) add(n);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'includes') {
      if (n.arguments.some(isIdLiteral)) add(n);
      const target = n.expression.expression;
      if (ts.isArrayLiteralExpression(target) && target.elements.some(isIdLiteral)) add(n);
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
): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  const idRe = new RegExp(ids.map((i) => i.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'));
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(ent.name) || /\.(test|spec)\.tsx?$/.test(ent.name) || ent.name.endsWith('.d.ts')) continue;
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
