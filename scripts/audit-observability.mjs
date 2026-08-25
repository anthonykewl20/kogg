import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const violations = [];
const diagnosticCatalog = loadDiagnosticCatalog();
const catalogIds = new Set(diagnosticCatalog.map(check => check.id));
const implementedDiagnosticIds = new Set();
const sourceRoots = ['packages', 'apps'];
const sourceFiles = sourceRoots.flatMap(relative => collect(path.join(root, relative)))
  .filter(file => /[/\\]src[/\\].*\.(?:ts|tsx)$/u.test(file))
  .filter(file => !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(file))
  .filter(file => !/[/\\](?:lib|dist|src-gen|node_modules)[/\\]/u.test(file));

verifySourceMaps();
for (const file of sourceFiles) inspectSource(file);
for (const check of diagnosticCatalog) {
  if (!implementedDiagnosticIds.has(check.id)) {
    violations.push(`diagnostics/catalog.json: diagnostic check ${check.id} is catalogued but has no runtime implementation`);
  }
}

if (violations.length) {
  console.error(`Observability gate failed (${violations.length} violation${violations.length === 1 ? '' : 's'}):`);
  console.error(violations.map(item => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.info(`Observability gate passed (${sourceFiles.length} production source files inspected).`);
}

function verifySourceMaps() {
  const configPath = path.join(root, 'tsconfig.base.json');
  const parsed = ts.parseConfigFileTextToJson(configPath, fs.readFileSync(configPath, 'utf8'));
  if (parsed.error) {
    violations.push('tsconfig.base.json cannot be parsed');
    return;
  }
  const options = parsed.config?.compilerOptions ?? {};
  if (options.sourceMap !== true) violations.push('tsconfig.base.json must set compilerOptions.sourceMap to true');
  if (options.declarationMap !== true) violations.push('tsconfig.base.json must set compilerOptions.declarationMap to true');
}

function inspectSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  const implementationFile = /[/\\]src[/\\](?:browser|node|electron-main|electron-browser)[/\\]/u.test(file)
    && !/(?:^|[/\\])(?:frontend-module|backend-module)\.tsx?$/u.test(file);
  const hasStandardLogger = /\[kogg:[a-z0-9-]+:[a-z0-9-]+\]/u.test(text)
    || /@named\(['"]kogg:[a-z0-9-]+:[a-z0-9-]+['"]\)/u.test(text);
  const hasFileExemption = /observability-exempt:\s*[^\r\n]{20,}/u.test(text);
  if (implementationFile && !hasStandardLogger && !hasFileExemption) {
    violations.push(`${relative}:1:1 implementation file must use a standardized Kogg logger or carry a specific observability exemption`);
  }

  for (const match of text.matchAll(/\bid\s*:\s*['"]([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)['"]/gu)) {
    if (match[1]) implementedDiagnosticIds.add(match[1]);
  }

  const coverage = [...text.matchAll(/diagnostic-coverage:\s*([^\r\n]+)/gu)]
    .flatMap(match => (match[1] ?? '').split(',').map(id => id.trim()).filter(Boolean));
  const diagnosticExemptions = [...text.matchAll(/diagnostic-exempt:\s*([^\r\n]+)/gu)];
  if (implementationFile && coverage.length === 0 && diagnosticExemptions.length === 0) {
    violations.push(`${relative}:1:1 implementation file must declare diagnostic-coverage or a specific diagnostic-exempt reason`);
  }
  for (const id of coverage) {
    if (!catalogIds.has(id)) violations.push(`${relative}: diagnostic coverage references uncatalogued check ${id}`);
  }
  for (const match of diagnosticExemptions) {
    const reason = match[1]?.trim() ?? '';
    if (reason.length < 20 || /^(?:not needed|n\/a|none|false positive)[.!]?$/iu.test(reason)) {
      report(relative, source, match.index ?? 0, 'diagnostic exemption needs a specific reason of at least 20 characters');
    }
  }

  for (const match of text.matchAll(/observability-exempt:\s*([^\r\n]+)/gu)) {
    const reason = match[1]?.trim() ?? '';
    if (reason.length < 20 || /^(?:not needed|n\/a|none|false positive)[.!]?$/iu.test(reason)) {
      report(relative, source, match.index ?? 0, 'observability exemption needs a specific reason of at least 20 characters');
    }
  }

  visit(source);
  function visit(node) {
    if (ts.isCatchClause(node)) inspectCatch(node);
    if (ts.isCallExpression(node)) inspectLogCall(node);
    ts.forEachChild(node, visit);
  }

  function inspectCatch(node) {
    const body = node.block.getText(source);
    const adjacent = text.slice(Math.max(0, node.getFullStart() - 180), node.end + 180);
    const exempt = /observability-exempt:\s*[^\r\n]{20,}/u.test(adjacent);
    const observable = /(?:console\.(?:debug|info|warn|error)|\blogger\.(?:debug|info|warn|error|fatal)|\bthrow\b)/u.test(body);
    if (!observable && !exempt) {
      report(relative, source, node.getStart(source), 'catch path must log, rethrow, or carry a specific observability-exempt reason');
    }
  }

  function inspectLogCall(node) {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const owner = node.expression.expression.getText(source);
    const level = node.expression.name.text;
    if (owner !== 'console' || !['debug', 'info', 'warn', 'error'].includes(level)) return;
    const first = node.arguments[0];
    if (!first || (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first))) {
      report(relative, source, node.getStart(source), 'console log must use a static [kogg:<area>:<component>] first argument');
      return;
    }
    if (!/^\[kogg:[a-z0-9-]+:[a-z0-9-]+\](?:\s+[a-z0-9][a-z0-9.-]*)?/u.test(first.text)) {
      report(relative, source, node.getStart(source), 'console log must start with [kogg:<area>:<component>] and a stable event name');
    }
    const loggedValues = node.arguments.slice(1).map(argument => argument.getText(source)).join(' ');
    if (/\b(?:authorization|cookie|credential|password|prompt|secret|token)\b/iu.test(loggedValues)) {
      report(relative, source, node.getStart(source), 'log expression may expose sensitive or content-bearing data');
    }
  }
}

function report(relative, source, position, message) {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  violations.push(`${relative}:${line + 1}:${character + 1} ${message}`);
}

function collect(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'lib', 'dist', 'src-gen'].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(target) : [target];
  });
}

function loadDiagnosticCatalog() {
  const catalogPath = path.join(root, 'diagnostics', 'catalog.json');
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.checks)) throw new Error('unsupported schema');
    const ids = new Set();
    for (const check of catalog.checks) {
      if (!check || typeof check.id !== 'string' || typeof check.owner !== 'string' || typeof check.description !== 'string') {
        throw new Error('invalid check entry');
      }
      if (ids.has(check.id)) throw new Error(`duplicate check ${check.id}`);
      ids.add(check.id);
    }
    return catalog.checks;
  } catch (error) {
    violations.push(`diagnostics/catalog.json is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    return [];
  }
}
