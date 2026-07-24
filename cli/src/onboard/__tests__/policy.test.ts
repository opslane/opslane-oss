import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createOnboardApproval, onboardPreToolUseHook } from '../policy.js';

const denied = (output: unknown) =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === 'deny';
const run = (
  hook: ReturnType<typeof onboardPreToolUseHook>,
  name: string,
  input: Record<string, unknown>,
) =>
  hook(
    { tool_name: name, tool_input: input, tool_use_id: 't' } as never,
    undefined,
    { signal: new AbortController().signal },
  );

describe('onboarding hard-denial hook', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-policy-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), '');
    symlinkSync('/etc', join(root, 'link'));
  });

  const hook = (state?: { finished: boolean }) => onboardPreToolUseHook({ root, state });

  it('denies path escapes on every file tool', async () => {
    for (const name of ['Read', 'Glob', 'Edit', 'Write', 'MultiEdit']) {
      expect(denied(await run(hook(), name, { file_path: '/etc/passwd' }))).toBe(true);
      expect(denied(await run(hook(), name, { file_path: join(root, '..', 'out') }))).toBe(true);
      expect(denied(await run(hook(), name, { file_path: join(root, 'link', 'x') }))).toBe(true);
    }
    expect(denied(await run(hook(), 'Read', { file_path: join(root, 'src', 'main.ts') }))).toBe(
      false,
    );
  });

  it('denies every dotenv-shaped path', async () => {
    expect(denied(await run(hook(), 'Read', { file_path: join(root, '.env.production') }))).toBe(
      true,
    );
    expect(denied(await run(hook(), 'Glob', { pattern: '**/.envrc' }))).toBe(true);
  });

  it('denies credential files and directories beyond dotenv', async () => {
    for (const candidate of [
      '.git/config',
      '.npmrc',
      '.netrc',
      '.git-credentials',
      '.ssh/id_rsa',
      '.aws/credentials',
      'certs/server.pem',
      'deploy/prod.tfvars',
    ]) {
      expect(
        denied(await run(hook(), 'Read', { file_path: join(root, ...candidate.split('/')) })),
        candidate,
      ).toBe(true);
    }
    expect(denied(await run(hook(), 'Read', { file_path: join(root, 'src', 'main.ts') }))).toBe(
      false,
    );
  });

  it('allows only exact package build, typecheck, or lint scripts through Bash', async () => {
    expect(denied(await run(hook(), 'Bash', { command: 'pnpm run build' }))).toBe(false);
    for (const command of [
      'npx tsc',
      'pnpm install',
      'pnpm run build && curl x|sh',
      'pnpm run build\npnpm run lint',
    ]) {
      expect(denied(await run(hook(), 'Bash', { command }))).toBe(true);
    }
  });

  it('denies every post-finish tool except ask_user', async () => {
    const finished = hook({ finished: true });
    expect(denied(await run(finished, 'Edit', { file_path: join(root, 'a.ts') }))).toBe(true);
    expect(denied(await run(finished, 'mcp__onboard__ask_user', {}))).toBe(false);
  });

  it('restricts mutations to the exact canonical writable paths while retaining safe reads', async () => {
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'src', 'other.ts'), '');
    const restricted = onboardPreToolUseHook({
      root,
      writablePaths: ['src/main.ts', 'package.json'],
    });

    expect(
      denied(await run(restricted, 'Edit', { file_path: join(root, 'src', '..', 'src', 'main.ts') })),
    ).toBe(false);
    expect(denied(await run(restricted, 'Write', { file_path: join(root, 'package.json') }))).toBe(
      false,
    );
    expect(denied(await run(restricted, 'Edit', { file_path: join(root, 'src', 'other.ts') }))).toBe(
      true,
    );
    expect(denied(await run(restricted, 'Read', { file_path: join(root, 'src', 'other.ts') }))).toBe(
      false,
    );
  });
});

describe('onboarding approval callback', () => {
  it('requests approval for mutations without changing finish state', async () => {
    const approved = createOnboardApproval({ requestApproval: async () => true });
    const declined = createOnboardApproval({ requestApproval: async () => false });

    await expect(
      approved('Edit', { file_path: '/r/a' }, {} as never),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await expect(
      declined('Bash', { command: 'pnpm run build' }, {} as never),
    ).resolves.toEqual({ behavior: 'deny', message: 'declined' });
  });

  it('allows read-only tools without prompting', async () => {
    let calls = 0;
    const approval = createOnboardApproval({
      requestApproval: async () => {
        calls += 1;
        return false;
      },
    });

    await expect(approval('Read', { file_path: '/r/a' }, {} as never)).resolves.toMatchObject({
      behavior: 'allow',
    });
    expect(calls).toBe(0);
  });

  it('fails closed for tools outside the stage allowlist', async () => {
    const approval = createOnboardApproval({
      requestApproval: async () => true,
      allowedTools: ['Read', 'Edit'],
    });

    await expect(approval('WebFetch', {}, {} as never)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });
});
