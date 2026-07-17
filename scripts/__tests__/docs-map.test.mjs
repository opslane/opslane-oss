import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildDocsIndex,
  findUncoveredProseDocs,
  globToRegExp,
  isProseTierDoc,
  mapChangedPaths,
  readCovers,
} from '../docs-map.mjs';

const DOCS = [
  {
    path: 'docs/guides/react.md',
    covers: ['packages/sdk/src/react.tsx', 'packages/sdk/vite-plugin/**'],
  },
  { path: 'docs/guides/vue.md', covers: ['packages/sdk/src/vue.ts'] },
  {
    path: 'docs/architecture/overview.md',
    covers: ['packages/sdk/**', 'packages/worker/**'],
  },
];

test('isProseTierDoc uses the canonical prose-tier scope', () => {
  for (const path of [
    'docs/guides/react.md',
    'docs/architecture/overview.md',
    'docs/quickstart/self-host.md',
    'docs/install.md',
    './docs/guides/vue.md',
  ]) {
    assert.equal(isProseTierDoc(path), true, path);
  }

  for (const path of [
    'docs/reference/http-routes.md',
    'docs/contracts/reliability.md',
    'docs/agents/domain.md',
    'docs/plans/x.md',
    'packages/sdk/src/index.ts',
    'docs/guides/react.txt',
    'docs/guides.md',
  ]) {
    assert.equal(isProseTierDoc(path), false, path);
  }
});

test('readCovers parses a non-empty YAML list', () => {
  const source = [
    '---',
    'title: React guide',
    'covers:',
    '  - packages/sdk/src/react.tsx',
    "  - 'packages/sdk/vite-plugin/**'",
    '---',
    '# React',
  ].join('\n');

  assert.deepEqual(readCovers(source), [
    'packages/sdk/src/react.tsx',
    'packages/sdk/vite-plugin/**',
  ]);
});

test('readCovers returns an empty list when frontmatter or covers is absent', () => {
  assert.deepEqual(readCovers('# React'), []);
  assert.deepEqual(readCovers('---\ntitle: React\n---\n# React'), []);
});

test('readCovers rejects malformed covers frontmatter loudly', () => {
  assert.throws(() => readCovers('---\ncovers:\n  - packages/sdk/**'), /unterminated/i);
  assert.throws(() => readCovers('---\ncovers:\n---\n# Empty'), /empty covers/i);
  assert.throws(() => readCovers('---\ncovers: []\n---\n# Empty'), /empty covers/i);
  assert.throws(
    () => readCovers('---\ncovers: packages/sdk/**\n---\n# Scalar'),
    /covers.*list/i,
  );
});

test('globToRegExp implements exact, single-star, and double-star matching', () => {
  const recursive = globToRegExp('packages/sdk/vite-plugin/**');
  assert.equal(recursive.test('packages/sdk/vite-plugin/index.ts'), true);
  assert.equal(recursive.test('packages/sdk/src/index.ts'), false);

  const exact = globToRegExp('packages/sdk/src/react.tsx');
  assert.equal(exact.test('packages/sdk/src/react.tsx'), true);
  assert.equal(exact.test('packages/sdk/src/react.test.tsx'), false);

  const oneSegment = globToRegExp('packages/*/package.json');
  assert.equal(oneSegment.test('packages/sdk/package.json'), true);
  assert.equal(oneSegment.test('packages/sdk/src/package.json'), false);

  const middleRecursive = globToRegExp('packages/**/index.ts');
  assert.equal(middleRecursive.test('packages/index.ts'), true);
  assert.equal(middleRecursive.test('packages/sdk/src/index.ts'), true);
});

test('mapChangedPaths unions overlapping matches, deduplicated and sorted', () => {
  const result = mapChangedPaths(
    ['packages/sdk/src/react.tsx', './packages/sdk/src/react.tsx'],
    DOCS,
  );

  assert.deepEqual(result, {
    matched: ['docs/architecture/overview.md', 'docs/guides/react.md'],
    uncovered: [],
  });
});

test('mapChangedPaths reports only unmatched code as uncovered', () => {
  const result = mapChangedPaths(
    [
      'packages/ingestion/handler/routes.go',
      'packages/sdk/src/__tests__/react.test.tsx',
      'packages/sdk/src/core.test.ts',
      'packages/ingestion/handler/routes_test.go',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      '.gitignore',
      '.gitleaks.toml',
      'Dockerfile',
      'packages/sdk/vite.config.ts',
      'packages/ingestion/go.mod',
      'tsconfig.json',
      '.github/workflows/ci.yml',
      'README.md',
      'docs/guides/react.md',
    ],
    DOCS,
  );

  assert.deepEqual(result.uncovered, ['packages/ingestion/handler/routes.go']);
});

test('mapChangedPaths handles empty, invalid, renamed, deleted, and non-existent paths', () => {
  assert.deepEqual(mapChangedPaths([], DOCS), { matched: [], uncovered: [] });
  assert.doesNotThrow(() => mapChangedPaths(['', null, undefined], DOCS));

  const oldAndNew = mapChangedPaths(
    ['packages/sdk/src/react.tsx', 'packages/sdk/src/react-renamed.tsx'],
    DOCS,
  );
  assert.deepEqual(oldAndNew.matched, [
    'docs/architecture/overview.md',
    'docs/guides/react.md',
  ]);
  assert.deepEqual(oldAndNew.uncovered, []);

  assert.deepEqual(mapChangedPaths(['packages/unknown/missing.ts'], DOCS).uncovered, [
    'packages/unknown/missing.ts',
  ]);
});

test('buildDocsIndex reads only prose-tier docs from an injected fixture root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'docs/guides/nested'), { recursive: true });
  mkdirSync(join(root, 'docs/reference'), { recursive: true });
  writeFileSync(
    join(root, 'docs/guides/react.md'),
    '---\ncovers:\n  - packages/sdk/src/react.tsx\n---\n# React',
  );
  writeFileSync(
    join(root, 'docs/guides/nested/advanced.md'),
    '---\ncovers:\n  - packages/sdk/src/advanced.ts\n---\n# Advanced',
  );
  writeFileSync(join(root, 'docs/reference/x.md'), '# Not prose-tier');

  assert.deepEqual(buildDocsIndex(root), [
    {
      path: 'docs/guides/nested/advanced.md',
      covers: ['packages/sdk/src/advanced.ts'],
    },
    { path: 'docs/guides/react.md', covers: ['packages/sdk/src/react.tsx'] },
  ]);
});

test('buildDocsIndex drops a deleted prose doc from the index', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-map-deleted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/guides'), { recursive: true });
  const doc = join(root, 'docs/guides/deleted.md');
  writeFileSync(doc, '---\ncovers:\n  - packages/sdk/src/deleted.ts\n---\n# Deleted');
  assert.equal(buildDocsIndex(root).length, 1);
  unlinkSync(doc);
  assert.deepEqual(buildDocsIndex(root), []);
});

test('buildDocsIndex includes the failing doc path for malformed frontmatter', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'docs-map-malformed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/guides'), { recursive: true });
  writeFileSync(join(root, 'docs/guides/bad.md'), '---\ncovers:\n  - packages/sdk/**');

  assert.throws(() => buildDocsIndex(root), /docs\/guides\/bad\.md.*unterminated/i);
});

test('findUncoveredProseDocs returns untagged docs sorted', () => {
  assert.deepEqual(
    findUncoveredProseDocs([
      { path: 'docs/guides/vue.md', covers: [] },
      { path: 'docs/guides/react.md', covers: ['packages/sdk/src/react.tsx'] },
      { path: 'docs/architecture/overview.md', covers: [] },
    ]),
    ['docs/architecture/overview.md', 'docs/guides/vue.md'],
  );
});
