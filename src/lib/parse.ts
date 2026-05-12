import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
// @ts-ignore — no types ship with these grammars
import TypeScript from 'tree-sitter-typescript';
// @ts-ignore
import JavaScript from 'tree-sitter-javascript';

export interface ImportInfo {
  specifier: string | null;
  symbols: string[];
  dynamic: boolean;
  typeOnly: boolean;
  usedCount: number;
}

export interface ParseError {
  line: number;
  column: number;
  text: string;
}

export interface ParseResult {
  imports: ImportInfo[];
  exports: string[];
  parseErrors: ParseError[];
}

function pickGrammar(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith('.tsx')) return TypeScript.tsx;
  if (p.endsWith('.ts')) return TypeScript.typescript;
  // .js, .jsx, .mjs, .cjs — tree-sitter-javascript handles JSX.
  return JavaScript;
}

const parserPool = new Map<unknown, Parser>();
function getParser(grammar: unknown): Parser {
  let p = parserPool.get(grammar);
  if (!p) {
    p = new Parser();
    p.setLanguage(grammar as Parser.Language);
    parserPool.set(grammar, p);
  }
  return p;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

function walkErrors(node: Parser.SyntaxNode, errors: ParseError[]): void {
  if (node.isMissing || (node as any).hasError === true && node.type === 'ERROR') {
    if (node.type === 'ERROR' || node.isMissing) {
      const start = node.startPosition;
      errors.push({
        line: start.row + 1,
        column: start.column,
        text: node.text.slice(0, 80),
      });
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    walkErrors(c, errors);
  }
}

interface ImportBuilder {
  specifier: string | null;
  symbols: string[];
  dynamic: boolean;
  typeOnly: boolean;
  // Track the local name → tracked for usage-count later
  localNames: string[];
}

function extractFromImportStatement(node: Parser.SyntaxNode): ImportBuilder | null {
  // Either: import [type] ...clause from 'mod';
  // Or: import 'mod';
  // Or: import('mod') as call_expression — handled separately.
  const sourceNode = node.childForFieldName('source');
  const source =
    sourceNode && sourceNode.namedChildCount > 0
      ? sourceNode.namedChild(0)!
      : sourceNode;
  if (!source) return null;
  const specifier = unquote(source.text);

  const builder: ImportBuilder = {
    specifier,
    symbols: [],
    dynamic: false,
    typeOnly: false,
    localNames: [],
  };

  let importStatementTypeOnly = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!;
    if (c.type === 'type' || c.text === 'type') {
      // top-level `import type`
      importStatementTypeOnly = true;
      break;
    }
    if (c.type === 'import_clause' || c.type === 'string') break;
  }

  // Walk the import clause: find import_specifier (named), default identifier, namespace_import.
  let hasMixedValue = false;
  let allTypeOnly = importStatementTypeOnly;
  let anySymbol = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'import_clause') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const sub = child.namedChild(j)!;
        if (sub.type === 'identifier') {
          // default import: import React from '...'
          anySymbol = true;
          builder.symbols.push('default');
          builder.localNames.push(sub.text);
          if (!importStatementTypeOnly) hasMixedValue = true;
        } else if (sub.type === 'namespace_import') {
          anySymbol = true;
          builder.symbols.push('*');
          // get binding identifier
          for (let k = 0; k < sub.namedChildCount; k++) {
            const id = sub.namedChild(k)!;
            if (id.type === 'identifier') builder.localNames.push(id.text);
          }
          if (!importStatementTypeOnly) hasMixedValue = true;
        } else if (sub.type === 'named_imports') {
          for (let k = 0; k < sub.namedChildCount; k++) {
            const spec = sub.namedChild(k)!;
            if (spec.type === 'import_specifier') {
              anySymbol = true;
              // optional inline `type` keyword as a leading anonymous child
              let inlineType = false;
              const first = spec.child(0);
              if (first && first.text === 'type') inlineType = true;
              const nameNode =
                spec.childForFieldName('name') ?? spec.namedChild(0);
              const aliasNode = spec.childForFieldName('alias');
              const symbolName = nameNode?.text ?? '';
              if (symbolName) builder.symbols.push(symbolName);
              const localName = aliasNode?.text ?? symbolName;
              if (localName) builder.localNames.push(localName);
              if (!inlineType && !importStatementTypeOnly) hasMixedValue = true;
              if (inlineType) {
                // mark sub as type-only later via tally
              }
              if (importStatementTypeOnly) {
                // override: keep type-only true
              }
            }
          }
        }
      }
    }
  }

  if (importStatementTypeOnly) {
    builder.typeOnly = true;
  } else if (anySymbol && !hasMixedValue) {
    // all symbols were inline-type
    builder.typeOnly = true;
  } else {
    builder.typeOnly = false;
  }

  return builder;
}

function extractFromExportFromStatement(node: Parser.SyntaxNode): { spec: string; exports: string[] } | null {
  // export { foo, bar as baz } from 'mod';
  // export * from 'mod';
  const sourceNode = node.childForFieldName('source');
  const source = sourceNode && sourceNode.namedChildCount > 0 ? sourceNode.namedChild(0)! : sourceNode;
  if (!source) return null;
  const specifier = unquote(source.text);
  const exports: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === 'export_clause') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const exp = c.namedChild(j)!;
        if (exp.type === 'export_specifier') {
          const nameNode = exp.childForFieldName('name') ?? exp.namedChild(0);
          const aliasNode = exp.childForFieldName('alias');
          const exported = (aliasNode ?? nameNode)?.text ?? '';
          if (exported) exports.push(exported);
        }
      }
    }
  }
  return { spec: specifier, exports };
}

function collectIdentifiers(node: Parser.SyntaxNode, counts: Map<string, number>) {
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'identifier' || cur.type === 'property_identifier' || cur.type === 'shorthand_property_identifier') {
      counts.set(cur.text, (counts.get(cur.text) ?? 0) + 1);
    }
    for (let i = 0; i < cur.namedChildCount; i++) stack.push(cur.namedChild(i)!);
  }
}

function countUsages(root: Parser.SyntaxNode, importNode: Parser.SyntaxNode, localNames: string[]): number {
  if (localNames.length === 0) return 0;
  // Count identifier occurrences anywhere in the file MINUS those that fall
  // inside the import statement itself (the binding declaration shouldn't count).
  const allCounts = new Map<string, number>();
  collectIdentifiers(root, allCounts);
  const localCounts = new Map<string, number>();
  collectIdentifiers(importNode, localCounts);
  let used = 0;
  for (const name of localNames) {
    const total = allCounts.get(name) ?? 0;
    const inImport = localCounts.get(name) ?? 0;
    if (total - inImport > 0) used += 1;
  }
  return used;
}

function findDynamicImports(root: Parser.SyntaxNode): ImportBuilder[] {
  const out: ImportBuilder[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      const argsNode = cur.childForFieldName('arguments');
      const isDynamic = fn?.type === 'import' || fn?.text === 'import';
      const isRequire = fn?.type === 'identifier' && fn.text === 'require';
      if (isDynamic || isRequire) {
        const firstArg = argsNode?.namedChild(0);
        let specifier: string | null = null;
        if (firstArg) {
          if (firstArg.type === 'string') {
            specifier = firstArg.namedChildCount > 0 ? unquote(firstArg.text) : unquote(firstArg.text);
            // Strip outer quotes if still present
            specifier = specifier.replace(/^['"`]/, '').replace(/['"`]$/, '');
          } else {
            specifier = null;
          }
        }
        out.push({
          specifier,
          symbols: [],
          dynamic: isDynamic === true,
          typeOnly: false,
          localNames: [],
        });
      }
    }
    for (let i = 0; i < cur.namedChildCount; i++) stack.push(cur.namedChild(i)!);
  }
  return out;
}

function findExports(root: Parser.SyntaxNode, exports: Set<string>, importNodes: Set<Parser.SyntaxNode>): void {
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'export_statement') {
      // export { ... } from ... is handled by caller (recorded as import-from)
      const sourceField = cur.childForFieldName('source');
      if (sourceField) {
        // export-from re-export: also yields exported names as exports
        const info = extractFromExportFromStatement(cur);
        if (info) {
          for (const e of info.exports) exports.add(e);
        }
      } else {
        // export const/let/function/class/default ...
        // Detect `export default`
        let isDefault = false;
        for (let i = 0; i < cur.childCount; i++) {
          const c = cur.child(i)!;
          if (c.type === 'default' || c.text === 'default') {
            isDefault = true;
            break;
          }
        }
        if (isDefault) {
          exports.add('default');
        }
        // Look for declarations inside
        for (let i = 0; i < cur.namedChildCount; i++) {
          const c = cur.namedChild(i)!;
          if (c.type === 'export_clause') {
            for (let j = 0; j < c.namedChildCount; j++) {
              const exp = c.namedChild(j)!;
              if (exp.type === 'export_specifier') {
                const nameNode = exp.childForFieldName('name') ?? exp.namedChild(0);
                const aliasNode = exp.childForFieldName('alias');
                const exported = (aliasNode ?? nameNode)?.text ?? '';
                if (exported) exports.add(exported);
              }
            }
          } else if (
            c.type === 'lexical_declaration' ||
            c.type === 'variable_declaration'
          ) {
            for (let j = 0; j < c.namedChildCount; j++) {
              const decl = c.namedChild(j)!;
              if (decl.type === 'variable_declarator') {
                const name = decl.childForFieldName('name');
                if (name?.type === 'identifier') exports.add(name.text);
              }
            }
          } else if (c.type === 'function_declaration' || c.type === 'class_declaration') {
            const name = c.childForFieldName('name');
            if (name?.text) exports.add(name.text);
          }
        }
      }
      continue;
    }
    if (cur.type === 'import_statement') {
      importNodes.add(cur);
    }
    // CommonJS: module.exports = { foo, bar } or exports.foo = ...
    if (cur.type === 'assignment_expression') {
      const left = cur.childForFieldName('left');
      const right = cur.childForFieldName('right');
      if (left?.type === 'member_expression') {
        const objNode = left.childForFieldName('object');
        const propNode = left.childForFieldName('property');
        const obj = objNode?.text;
        const prop = propNode?.text;
        // module.exports = { ... }
        if (obj === 'module' && prop === 'exports' && right?.type === 'object') {
          for (let i = 0; i < right.namedChildCount; i++) {
            const pair = right.namedChild(i)!;
            if (pair.type === 'pair') {
              const key = pair.childForFieldName('key');
              if (key?.type === 'property_identifier' || key?.type === 'identifier') {
                exports.add(key.text);
              }
            } else if (pair.type === 'shorthand_property_identifier') {
              exports.add(pair.text);
            }
          }
        }
        // exports.foo = ...
        if (obj === 'exports' && prop) {
          exports.add(prop);
        }
        // module.exports.foo = ...
        if (
          objNode?.type === 'member_expression' &&
          objNode.childForFieldName('object')?.text === 'module' &&
          objNode.childForFieldName('property')?.text === 'exports' &&
          prop
        ) {
          exports.add(prop);
        }
      }
    }
    for (let i = 0; i < cur.namedChildCount; i++) stack.push(cur.namedChild(i)!);
  }
}

export function parseSource(path: string): ParseResult {
  const grammar = pickGrammar(path);
  const parser = getParser(grammar);
  const source = stripBom(readFileSync(path, 'utf8'));
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const imports: ImportInfo[] = [];
  const exportsSet = new Set<string>();
  const importNodes = new Set<Parser.SyntaxNode>();

  findExports(root, exportsSet, importNodes);

  for (const imp of importNodes) {
    const built = extractFromImportStatement(imp);
    if (!built || !built.specifier) continue;
    const usedCount = countUsages(root, imp, built.localNames);
    imports.push({
      specifier: built.specifier,
      symbols: built.symbols,
      dynamic: built.dynamic,
      typeOnly: built.typeOnly,
      usedCount: built.symbols.length === 0 ? 0 : usedCount,
    });
  }

  // Re-exports `export { foo } from './x'` register as imports too (graph edges).
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'export_statement') {
      const sourceField = cur.childForFieldName('source');
      if (sourceField) {
        const info = extractFromExportFromStatement(cur);
        if (info) {
          imports.push({
            specifier: info.spec,
            symbols: info.exports,
            dynamic: false,
            typeOnly: false,
            usedCount: 0,
          });
        }
      }
    }
    for (let i = 0; i < cur.namedChildCount; i++) stack.push(cur.namedChild(i)!);
  }

  // Dynamic imports + require()
  for (const dyn of findDynamicImports(root)) {
    imports.push({
      specifier: dyn.specifier,
      symbols: [],
      dynamic: dyn.dynamic,
      typeOnly: false,
      usedCount: 0,
    });
  }

  const parseErrors: ParseError[] = [];
  walkErrors(root, parseErrors);

  return {
    imports,
    exports: Array.from(exportsSet),
    parseErrors,
  };
}
