#!/usr/bin/env node
// Docs drift check: fails (exit 1) when reference docs and source disagree.
//
// Checks:
//   1. SDK fetch paths vs routes registered in routes.go (would have caught issue #13)
//   2. Registered routes vs docs/reference/http-routes.md
//   3. Env vars read by ingestion/worker vs docs/reference/environment-variables.md
//   4. ReasonCode union vs docs/reference/reason-codes.md
//
// Run: node scripts/check-docs-drift.mjs   (or `pnpm docs:check`)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const problems = [];

// Known drift, allowlisted with a tracking issue. Remove entries as bugs close.
const KNOWN_DRIFT = new Map([
  ['POST /api/v1/replays/{param}/fail', 'https://github.com/opslane/opslane-oss/issues/13'],
]);

// ---------- 1+2. Routes ----------
function registeredRoutes() {
  const src = read('packages/ingestion/handler/routes.go');
  const routes = new Set();
  const prefixStack = []; // { prefix, depth }
  let depth = 0;
  for (const line of src.split('\n')) {
    const routeM = line.match(/r\.Route\("([^"]+)"/);
    const methodM = line.match(/\.(Get|Post|Put|Patch|Delete|HandleFunc)\("(\/[^"]*)"/);
    if (methodM && !routeM) {
      const prefix = prefixStack.map((p) => p.prefix).join('');
      const path = (prefix + methodM[2]).replace(/\{[^}]+\}/g, '{param}');
      const method = methodM[1] === 'HandleFunc' ? 'ANY' : methodM[1].toUpperCase();
      routes.add(`${method} ${path}`);
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (routeM) prefixStack.push({ prefix: routeM[1], depth });
    while (prefixStack.length && depth < prefixStack.at(-1).depth) prefixStack.pop();
  }
  return routes;
}

function sdkCalledPaths() {
  const dir = join(root, 'packages/sdk/src');
  const paths = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('test'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/\$\{config\.endpoint\}(\/api\/v1\/[^`]+)`/g)) {
      const path = m[1]
        .replace(/\$\{[^}]+\}/g, '{param}')
        .replace(/\?.*$/, '');
      paths.add(path);
    }
  }
  return paths;
}

const routes = registeredRoutes();
const routePathsOnly = new Set([...routes].map((r) => r.split(' ')[1]));

// 1. Every SDK-called path must be registered (or allowlisted with an issue)
for (const p of sdkCalledPaths()) {
  if (!routePathsOnly.has(p)) {
    const key = [...KNOWN_DRIFT.keys()].find((k) => k.endsWith(` ${p}`));
    if (key) {
      console.warn(`⚠ known drift (allowlisted): SDK calls unregistered ${p} — ${KNOWN_DRIFT.get(key)}`);
    } else {
      problems.push(`SDK calls ${p} but routes.go does not register it`);
    }
  }
}

// 2. Route docs completeness, both directions
const routeDoc = read('docs/reference/http-routes.md');
const docPaths = new Set(
  [...routeDoc.matchAll(/\|\s*(?:GET|POST|PUT|PATCH|DELETE|GET\+POST|HMAC[^|]*)\s*\|\s*`([^`]+)`/g)]
    .map((m) => m[1].replace(/\{[^}]+\}/g, '{param}'))
);
for (const r of routes) {
  const path = r.split(' ')[1];
  if (!docPaths.has(path)) problems.push(`route ${r} is registered but missing from docs/reference/http-routes.md`);
}
for (const p of docPaths) {
  if (!routePathsOnly.has(p) && ![...KNOWN_DRIFT.keys()].some((k) => k.endsWith(` ${p}`))) {
    problems.push(`docs/reference/http-routes.md documents ${p} but routes.go does not register it`);
  }
}

// ---------- 3. Env vars ----------
function goEnvVars() {
  const vars = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(join(dir, e.name));
      else if (e.name.endsWith('.go') && !e.name.endsWith('_test.go')) {
        for (const m of readFileSync(join(root, dir, e.name), 'utf8').matchAll(/os\.Getenv\("([A-Z0-9_]+)"\)/g)) vars.add(m[1]);
      }
    }
  };
  walk('packages/ingestion');
  return vars;
}
function workerEnvVars() {
  const vars = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory() && !['node_modules', '__tests__'].includes(e.name)) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
        for (const m of readFileSync(join(root, dir, e.name), 'utf8').matchAll(/process\.env\[?['"]([A-Z0-9_]+)['"]\]?/g)) vars.add(m[1]);
      }
    }
  };
  walk('packages/worker/src');
  vars.delete('VITEST'); // test-runner detection, not configuration
  return vars;
}

const envDoc = read('docs/reference/environment-variables.md');
for (const v of [...goEnvVars(), ...workerEnvVars()]) {
  if (!envDoc.includes(v)) problems.push(`env var ${v} is read by code but missing from docs/reference/environment-variables.md`);
}

// ---------- 4. Reason codes ----------
const typesSrc = read('shared/src/types.ts');
const unionM = typesSrc.match(/export type ReasonCode =([\s\S]*?);/);
const codes = [...(unionM?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
if (codes.length === 0) problems.push('could not parse ReasonCode union from shared/src/types.ts');
const reasonDoc = read('docs/reference/reason-codes.md');
for (const c of codes) {
  if (!reasonDoc.includes(`\`${c}\``)) problems.push(`reason code ${c} exists in shared/src/types.ts but is missing from docs/reference/reason-codes.md`);
}
for (const m of reasonDoc.matchAll(/^\| `([a-z0-9_]+)` \|/gm)) {
  if (!codes.includes(m[1])) problems.push(`reason code ${m[1]} is documented but absent from shared/src/types.ts`);
}
const countM = reasonDoc.match(/(\d+) codes total/);
if (countM && Number(countM[1]) !== codes.length) {
  problems.push(`reason-codes.md says "${countM[1]} codes total" but shared/src/types.ts defines ${codes.length}`);
}

// ---------- verdict ----------
if (problems.length > 0) {
  console.error(`✗ docs drift detected (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ no docs drift: ${routes.size} routes, ${goEnvVars().size + workerEnvVars().size} env vars, ${codes.length} reason codes all consistent`);
