import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runPipeline } from '../pipeline.js';
import {
  createFixtureRepository,
  execFile,
  GIT_ENV,
  startProviderRecorders,
  toolNames,
  type ProviderRecorders,
} from './reliability-fixture.js';

describe('deterministic reliability tracer', () => {
  const savedEnv = new Map<string, string | undefined>();
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GITHUB_TOKEN',
    'OPSLANE_GITHUB_API_URL',
    'OPSLANE_SANDBOX_BACKEND',
    'OPSLANE_RELIABILITY_HARNESS',
  ] as const;
  let root: string | undefined;
  let providers: ProviderRecorders | undefined;

  afterEach(async () => {
    await providers?.close();
    if (root) await rm(root, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    root = undefined;
    providers = undefined;
  });

  it('turns a failing fixture into one tested branch and one recorded PR', async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    root = await mkdtemp(join(tmpdir(), 'opslane-reliability-tracer-'));
    const { remote, deliveryClone } = await createFixtureRepository(root);

    await expect(execFile('npm', ['test'], { cwd: deliveryClone })).rejects.toBeDefined();

    providers = await startProviderRecorders();
    const { anthropicJournal, githubJournal } = providers;
    process.env['ANTHROPIC_BASE_URL'] = providers.anthropicBaseUrl;
    process.env['OPSLANE_GITHUB_API_URL'] = providers.githubBaseUrl;
    process.env['ANTHROPIC_API_KEY'] = 'test-anthropic-key';
    process.env['GITHUB_TOKEN'] = 'test-github-token';
    process.env['OPSLANE_SANDBOX_BACKEND'] = 'local';
    process.env['OPSLANE_RELIABILITY_HARNESS'] = '1';

    const result = await runPipeline({
      jobId: 'job-reliability',
      errorGroupId: 'error-group-reliability',
      projectId: 'project-reliability',
      title: 'TypeError while rendering missing data',
      errorType: 'TypeError',
      errorMessage: "Cannot read properties of null (reading 'value')",
      stackTrace: 'TypeError: missing value\n    at value (src/value.js:1:39)',
      resolvedStackTrace: null,
      breadcrumbs: '[]',
      context: '{}',
      sourceFiles: [],
      visualAnalysis: null,
      repoPath: deliveryClone,
      repoUrl: `file://${remote}`,
      githubRepo: 'e2e/reliability',
      defaultBranch: 'main',
      githubToken: 'test-github-token',
      investigation: {
        rootCause: 'A nullable production value is dereferenced without a guard.',
        suggestedMitigation: 'Use a narrow fallback for the missing value.',
      },
    });

    expect(result).toEqual({
      status: 'pr_created',
      pr_url: 'https://github.test/e2e/reliability/pull/42',
      pr_number: 42,
      confidence: 'high',
    });
    expect(anthropicJournal).toHaveLength(5);
    expect(anthropicJournal.every((entry) => entry.path === '/v1/messages')).toBe(true);
    expect(anthropicJournal.every((entry) => entry.authorization === 'test-anthropic-key')).toBe(true);
    expect(toolNames(anthropicJournal[0]!.body)).toContain('edit');
    expect(toolNames(anthropicJournal[3]!.body)).toEqual(['score_diff']);
    expect(anthropicJournal[4]!.body['max_tokens']).toBe(220);

    expect(githubJournal).toHaveLength(1);
    expect(githubJournal[0]).toMatchObject({
      path: '/repos/e2e/reliability/pulls',
      authorization: 'token test-github-token',
      body: {
        head: expect.stringMatching(/^opslane\/fix-error-gr-/),
        base: 'main',
      },
    });

    const refs = await execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/opslane/'], {
      cwd: remote,
      env: GIT_ENV,
    });
    const pushedBranches = refs.stdout.trim().split('\n').filter(Boolean);
    expect(pushedBranches).toHaveLength(1);
    const pushedSource = await execFile('git', ['show', `${pushedBranches[0]}:src/value.js`], {
      cwd: remote,
      env: GIT_ENV,
    });
    expect(pushedSource.stdout).toContain("input?.value?.toUpperCase() ?? 'UNKNOWN'");

    const verified = join(root, 'verified');
    await execFile('git', ['clone', '--branch', pushedBranches[0]!, remote, verified], { env: GIT_ENV });
    await expect(execFile('npm', ['test'], { cwd: verified })).resolves.toMatchObject({ stdout: expect.any(String) });
    expect(await readFile(join(verified, 'src', 'value.js'), 'utf8')).toContain("?? 'UNKNOWN'");
  }, 60_000);
});
