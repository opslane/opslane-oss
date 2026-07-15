import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export const execFile = promisify(execFileCallback);
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Reliability Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@opslane.test',
  GIT_COMMITTER_NAME: 'Reliability Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@opslane.test',
};

export interface RecordedRequest {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

export interface FixtureRepository {
  remote: string;
  deliveryClone: string;
}

export interface ProviderRecorders {
  anthropicBaseUrl: string;
  githubBaseUrl: string;
  anthropicJournal: RecordedRequest[];
  githubJournal: RecordedRequest[];
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recorder did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function anthropicMessage(
  body: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
  stopReason: 'tool_use' | 'end_turn',
): Record<string, unknown> {
  return {
    id: `msg_fixture_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: body['model'],
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

export function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body['tools']) ? body['tools'] : [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const name = (tool as Record<string, unknown>)['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

function toolResultCount(body: Record<string, unknown>): number {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    count += content.filter((block) => (
      block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result'
    )).length;
  }
  return count;
}

export async function createFixtureRepository(
  root: string,
  remote: string = join(root, 'fixture.git'),
): Promise<FixtureRepository> {
  const seed = join(root, 'seed');
  const deliveryClone = join(root, 'delivery');
  await mkdir(join(seed, 'src'), { recursive: true });
  await mkdir(join(seed, 'test'), { recursive: true });
  await mkdir(dirname(remote), { recursive: true });
  await writeFile(join(seed, 'package.json'), JSON.stringify({
    name: 'opslane-reliability-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2));
  await writeFile(
    join(seed, 'src', 'value.js'),
    "export function value(input) { return input.value.toUpperCase(); }\n",
  );
  await writeFile(
    join(seed, 'test', 'value.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.js';",
      '',
      "test('handles missing production data', () => {",
      "  assert.equal(value(null), 'UNKNOWN');",
      '});',
      '',
    ].join('\n'),
  );
  await execFile('git', ['init', '--initial-branch=main'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['add', '-A'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['commit', '-m', 'seed failing fixture'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['clone', '--bare', seed, remote], { env: GIT_ENV });
  await execFile('git', ['clone', remote, deliveryClone], { env: GIT_ENV });
  return { remote, deliveryClone };
}

export async function startProviderRecorders(): Promise<ProviderRecorders> {
  const anthropicJournal: RecordedRequest[] = [];
  const anthropicServer = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    anthropicJournal.push({
      path: request.url ?? '',
      authorization: request.headers['x-api-key'] as string | undefined,
      body,
    });
    const names = toolNames(body);
    let message: Record<string, unknown>;
    if (names.includes('classify_error')) {
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_classify',
        name: 'classify_error',
        input: {
          fixable: true,
          confidence: 'high',
          reason: 'A nullable production value is dereferenced without a guard.',
          remediation: 'Use a narrow fallback for the missing value.',
        },
      }], 'tool_use');
    } else if (names.includes('score_diff')) {
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_judge',
        name: 'score_diff',
        input: {
          scope: 2,
          correctness: 2,
          preservation: 2,
          explanation: 'The change is minimal and covers the failing null input.',
        },
      }], 'tool_use');
    } else if (names.includes('edit')) {
      const results = toolResultCount(body);
      if (results === 0) {
        message = anthropicMessage(body, [{
          type: 'tool_use',
          id: 'tool_edit',
          name: 'edit',
          input: {
            path: '/home/user/repo/src/value.js',
            old_string: 'input.value.toUpperCase()',
            new_string: "input?.value?.toUpperCase() ?? 'UNKNOWN'",
          },
        }], 'tool_use');
      } else if (results === 1) {
        message = anthropicMessage(body, [{
          type: 'tool_use',
          id: 'tool_test',
          name: 'bash',
          input: { command: 'cd /home/user/repo && npm test -- --test-reporter=dot' },
        }], 'tool_use');
      } else {
        message = anthropicMessage(body, [{
          type: 'text',
          text: 'The null input was dereferenced before validation. The fix adds a narrow fallback and the test passes.',
        }], 'end_turn');
      }
    } else {
      message = anthropicMessage(body, [{
        type: 'text',
        text: 'A user encountered missing data. The page crashed while reading it. This change safely renders a fallback value.',
      }], 'end_turn');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
  });
  const anthropicBaseUrl = await listen(anthropicServer);

  const githubJournal: RecordedRequest[] = [];
  const githubServer = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    githubJournal.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      html_url: 'https://github.test/e2e/reliability/pull/42',
      number: 42,
    }));
  });
  const githubBaseUrl = await listen(githubServer);

  return {
    anthropicBaseUrl,
    githubBaseUrl,
    anthropicJournal,
    githubJournal,
    close: async () => Promise.all([close(anthropicServer), close(githubServer)]).then(() => undefined),
  };
}
