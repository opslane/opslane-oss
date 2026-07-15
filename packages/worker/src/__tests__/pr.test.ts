import { createServer } from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PRInput, GitHubClient, ReplayInput } from '../pr.js';
import {
  createGitHubClient,
  createPR,
  sanitize,
  buildPRBody,
  getGitHubClientOptions,
} from '../pr.js';

const VALID_DIFF = `--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,7 @@
-  console.log('old');
+  console.log('new');
`;

function makeInput(overrides?: Partial<PRInput>): PRInput {
  return {
    projectId: 'proj-1',
    errorGroupId: 'eg-12345678-abcd',
    githubRepo: 'octocat/hello-world',
    defaultBranch: 'main',
    branchName: 'opslane/fix-eg-12345-1234567890',
    diff: VALID_DIFF,
    title: 'TypeError: Cannot read property "x" of undefined',
    confidence: 'high',
    errorType: 'TypeError',
    errorMessage: 'Cannot read property "x" of undefined',
    ...overrides,
  };
}

function makeReplay(overrides?: Partial<ReplayInput>): ReplayInput {
  return {
    id: 'replay-1',
    sessionId: 'sess-1',
    triggerType: 'error',
    pageUrl: 'http://localhost:5173/users',
    startedAt: '2026-02-20T10:00:00.000Z',
    endedAt: '2026-02-20T10:00:05.000Z',
    status: 'complete',
    sizeBytes: 12345,
    signals: {
      eventTypeCounts: { click: 5, mousemove: 12 },
      consoleErrorCount: 2,
      consoleWarningCount: 1,
      consoleErrorMessages: ['TypeError: foo is undefined'],
      consoleWarningMessages: ['Deprecation warning'],
      networkAnomalyCount: 1,
      networkAnomalies: [{ method: 'POST', url: '/api/users', statusCode: 500 }],
      lastUserActions: [
        { timestamp: '2026-02-20T10:00:03.000Z', type: 'click', detail: 'button#submit' },
        { timestamp: '2026-02-20T10:00:04.000Z', type: 'input', detail: 'input#email' },
      ],
    },
    ...overrides,
  };
}

function makeMockClient(overrides?: {
  createPullRequest?: GitHubClient['createPullRequest'];
  getFileContent?: GitHubClient['getFileContent'];
}): GitHubClient {
  return {
    createPullRequest:
      overrides?.createPullRequest ??
      vi.fn<GitHubClient['createPullRequest']>().mockResolvedValue({
        url: 'https://github.com/octocat/hello-world/pull/42',
        number: 42,
      }),
    getFileContent:
      overrides?.getFileContent ??
      vi.fn<GitHubClient['getFileContent']>().mockResolvedValue(null),
  };
}

describe('createPR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns created with PR URL on success', async () => {
    const client = makeMockClient();
    const result = await createPR(makeInput(), () => client);

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.prUrl).toBe('https://github.com/octocat/hello-world/pull/42');
      expect(result.prNumber).toBe(42);
    }
  });

  it('returns failed with missing_github_token when no token', async () => {
    const result = await createPR(makeInput(), () => null);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason.reason_code).toBe('missing_github_token');
      expect(result.reason.reason_message).toBeTruthy();
      expect(result.reason.remediation).toBeTruthy();
    }
  });

  it('returns failed with repo_access_denied on 403', async () => {
    const client = makeMockClient({
      createPullRequest: vi
        .fn<GitHubClient['createPullRequest']>()
        .mockRejectedValue(new Error('403 Forbidden: Resource not accessible')),
    });

    const result = await createPR(makeInput(), () => client);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason.reason_code).toBe('repo_access_denied');
      expect(result.reason.reason_message).toContain('403');
      expect(result.reason.remediation).toBeTruthy();
    }
  });

  it('passes correct owner/repo to GitHub client', async () => {
    const createPullRequest = vi
      .fn<GitHubClient['createPullRequest']>()
      .mockResolvedValue({ url: 'https://github.com/org/repo/pull/1', number: 1 });
    const client = makeMockClient({ createPullRequest });

    await createPR(
      makeInput({ githubRepo: 'my-org/my-repo', defaultBranch: 'develop' }),
      () => client
    );

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'my-org',
        repo: 'my-repo',
        base: 'develop',
      })
    );
  });

  it('returns failed for invalid repo format', async () => {
    const client = makeMockClient();
    const result = await createPR(
      makeInput({ githubRepo: 'invalid-no-slash' }),
      () => client
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason.reason_code).toBe('repo_access_denied');
    }
  });
});

describe('GitHub client configuration', () => {
  const originalBaseUrl = process.env['OPSLANE_GITHUB_API_URL'];

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env['OPSLANE_GITHUB_API_URL'];
    else process.env['OPSLANE_GITHUB_API_URL'] = originalBaseUrl;
  });

  it('uses GitHub.com defaults when no API override is configured', () => {
    delete process.env['OPSLANE_GITHUB_API_URL'];
    expect(getGitHubClientOptions('test-token')).toEqual({ auth: 'test-token' });
  });

  it('routes Octokit through a recording protocol-compatible endpoint', () => {
    process.env['OPSLANE_GITHUB_API_URL'] = 'http://127.0.0.1:9199/api/v3';
    expect(getGitHubClientOptions('test-token')).toEqual({
      auth: 'test-token',
      baseUrl: 'http://127.0.0.1:9199/api/v3',
    });
  });

  it('sends the real Octokit pull-request schema to the configured endpoint', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          html_url: 'https://example.test/octocat/hello-world/pull/42',
          number: 42,
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Recorder did not bind to TCP');
      process.env['OPSLANE_GITHUB_API_URL'] = `http://127.0.0.1:${address.port}`;

      const client = createGitHubClient('test-token');
      expect(client).not.toBeNull();
      await expect(client!.createPullRequest({
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Fix the deterministic fixture',
        body: 'Recorded body',
        head: 'opslane/fix-fixture',
        base: 'main',
      })).resolves.toEqual({
        url: 'https://example.test/octocat/hello-world/pull/42',
        number: 42,
      });

      expect(requests).toEqual([{
        method: 'POST',
        url: '/repos/octocat/hello-world/pulls',
        authorization: 'token test-token',
        body: {
          title: 'Fix the deterministic fixture',
          body: 'Recorded body',
          head: 'opslane/fix-fixture',
          base: 'main',
        },
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('buildPRBody', () => {
  it('uses the explicit human summary as a header-free lede', () => {
    const body = buildPRBody(makeInput({
      humanSummary: '### The user submitted the form. The app crashed on submit. The fix guards the missing value.',
    }));

    expect(body).toContain('## 🛡️ Opslane fixed TypeError');
    expect(body).toContain('The user submitted the form. The app crashed on submit. The fix guards the missing value.');
    expect(body).not.toContain('### The user submitted');
  });

  it('falls back to visual analysis when humanSummary is absent and scrubs dev URLs', () => {
    const body = buildPRBody(makeInput({
      visualAnalysis: {
        whatUserSaw: 'The user was on http://localhost:5173/users and saw a blank screen',
        failureMoment: 'after clicking Save on http://127.0.0.1:5173/users',
        uxImpact: 'The form could not be submitted',
        confidence: 'high',
      },
    }));

    expect(body).toContain('The user was on /users and saw a blank screen.');
    expect(body).toContain('after clicking Save on /users.');
    expect(body).not.toContain('localhost');
    expect(body).not.toContain('127.0.0.1');
  });

  it('falls back to error type and message when summary and visual analysis are absent', () => {
    const body = buildPRBody(makeInput({
      humanSummary: '',
      visualAnalysis: null,
      errorType: 'ReferenceError',
      errorMessage: 'foo is not defined',
    }));

    expect(body).toContain('Opslane detected a ReferenceError (foo is not defined) and generated a fix.');
  });

  it('includes the fix and preserves the dynamic diff fence', () => {
    const diff = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const value = "```";',
      '+const value = "safe";',
    ].join('\n');
    const body = buildPRBody(makeInput({ diff }));

    expect(body).toContain('### The fix');
    expect(body).toContain('Changed files: `src/app.ts`');
    expect(body).toContain('````diff');
    expect(body).toContain('-const value = "```";');
  });

  it('hardcodes the verified high-confidence line for created PRs', () => {
    const body = buildPRBody(makeInput({ confidence: 'medium' }));

    expect(body).toContain('**Confidence:** High · ✅ Tests passing');
    expect(body).not.toContain('medium');
    expect(body).not.toContain('not verified');
  });

  it('includes exactly one dashboard link when DASHBOARD_URL is set', () => {
    const prev = process.env['DASHBOARD_URL'];
    process.env['DASHBOARD_URL'] = 'https://app.opslane.com';
    try {
      const body = buildPRBody(makeInput({ replay: makeReplay() }));
      expect(body).toContain('[Full investigation & session replay →](https://app.opslane.com/incidents/eg-12345678-abcd?project_id=proj-1)');
      expect(body.match(/\]\(https:\/\/app\.opslane\.com\/incidents\/eg-12345678-abcd\?project_id=proj-1\)/g)).toHaveLength(1);
      expect(body).not.toContain('Watch session replay');
    } finally {
      if (prev === undefined) delete process.env['DASHBOARD_URL'];
      else process.env['DASHBOARD_URL'] = prev;
    }
  });

  it('omits the dashboard link when no dashboard base is configured', () => {
    const prevUrl = process.env['DASHBOARD_URL'];
    const prevOrigin = process.env['DASHBOARD_ORIGIN'];
    delete process.env['DASHBOARD_URL'];
    delete process.env['DASHBOARD_ORIGIN'];
    try {
      const body = buildPRBody(makeInput({ replay: makeReplay() }));
      expect(body).not.toContain('Full investigation & session replay');
    } finally {
      if (prevUrl !== undefined) process.env['DASHBOARD_URL'] = prevUrl;
      if (prevOrigin !== undefined) process.env['DASHBOARD_ORIGIN'] = prevOrigin;
    }
  });

  it('renders root cause exactly once inside the fix section', () => {
    const body = buildPRBody(makeInput({
      rootCause: 'Null reference in useEffect cleanup due to stale closure',
      humanSummary: 'The user tried to save a profile. The page crashed. The patch guards the cleanup path.',
    }));

    expect(body.match(/Null reference in useEffect cleanup due to stale closure/g)).toHaveLength(1);
    expect(body).toContain('Addresses Null reference in useEffect cleanup due to stale closure');
    expect(body).not.toContain('### Root Cause');
    expect(body).not.toContain('**Explanation:**');
  });

  it('renders root cause once in the visual-analysis fallback (no humanSummary)', () => {
    const body = buildPRBody(makeInput({
      humanSummary: '',
      rootCause: 'Null reference in useEffect cleanup due to stale closure',
      visualAnalysis: {
        whatUserSaw: 'a blank profile page',
        failureMoment: 'right after clicking Save',
        uxImpact: 'The form could not be submitted',
        confidence: 'high',
      },
    }));

    // The lede uses the generic fix phrasing; rootCause appears only in `### The fix`.
    expect(body.match(/Null reference in useEffect cleanup due to stale closure/g)).toHaveLength(1);
    expect(body).toContain('This change updates the failing code path so the flow can complete.');
    expect(body).toContain('Addresses Null reference in useEffect cleanup due to stale closure');
  });

  it('demotes technical detail and removes chart, timeline, metadata, and verification noise', () => {
    const body = buildPRBody(makeInput({
      replay: makeReplay(),
      stackTrace: 'at main (src/app.ts:12:5)',
    }));

    expect(body).toContain('<details><summary>Technical detail</summary>\n\n#### Stack trace');
    expect(body).toContain('#### Signals');
    expect(body).not.toContain('```mermaid');
    expect(body).not.toContain('pie showData');
    expect(body).not.toContain('replay_id');
    expect(body).not.toContain('size_bytes');
    expect(body).not.toContain('trigger_type');
    expect(body).not.toContain('##### Timeline');
    expect(body).not.toContain('| Timestamp (UTC) | Signal | Detail |');
    expect(body).not.toContain('### Verification');
  });

  it('scrubs dev paths from stack trace frames in technical detail', () => {
    const body = buildPRBody(makeInput({
      stackTrace: 'at render (http://localhost:5173/@fs/Users/abhi/project/src/App.vue:42:9)',
    }));

    expect(body).toContain('`at render (src/App.vue:42:9)`');
    expect(body).not.toContain('localhost');
    expect(body).not.toContain('/@fs/');
    expect(body).not.toContain('/Users/');
  });

  it('renders visual analysis as prose and scrubs signal URLs', () => {
    const body = buildPRBody(makeInput({
      replay: makeReplay({
        signals: {
          consoleErrorCount: 2,
          consoleWarningCount: 1,
          networkAnomalyCount: 1,
          networkAnomalies: [{ method: 'POST', url: 'http://localhost:5173/api/users', statusCode: 500 }],
          lastUserActions: [
            { timestamp: '2026-02-20T10:00:04.000Z', type: 'click', detail: 'http://127.0.0.1:5173/users button#submit' },
          ],
        },
      }),
      visualAnalysis: {
        whatUserSaw: 'Blank white screen at http://localhost:5173/users after clicking Submit',
        failureMoment: 'Component unmounted during async fetch on http://127.0.0.1:5173/users',
        uxImpact: 'User cannot submit form, must reload page',
        confidence: 'high',
      },
    }));

    expect(body).toContain('#### What the replay showed');
    expect(body).toContain('The user saw Blank white screen at /users after clicking Submit.');
    expect(body).toContain('The failure happened around Component unmounted during async fetch on /users.');
    expect(body).toContain('2 console errors, 1 warning, 1 network anomaly');
    expect(body).toContain('last action: click (/users button#submit)');
    expect(body).toContain('first network anomaly: POST /api/users (500)');
    expect(body).not.toContain('what_user_saw');
    expect(body).not.toContain('localhost');
    expect(body).not.toContain('127.0.0.1');
  });

  it('sanitizes user-controlled fields', () => {
    const body = buildPRBody(makeInput({
      title: '<script>alert("xss")</script>',
      rootCause: '![evil](http://evil.com/img.png) injection',
      stackTrace: '<img src=x onerror=alert(1)>',
    }));

    expect(body).not.toContain('<script>');
    expect(body).not.toContain('![evil]');
    expect(body).not.toContain('<img');
  });

  it('includes footer with error group ID', () => {
    const body = buildPRBody(makeInput());
    expect(body).toContain('Error Group: `eg-12345`');
    expect(body).toContain('Opslane');
    expect(body).not.toContain('[Opslane]');
  });
});

describe('sanitize', () => {
  it('strips HTML angle brackets', () => {
    expect(sanitize('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
  });

  it('strips markdown images', () => {
    expect(sanitize('Check this ![evil](http://evil.com/img.png) out')).toBe('Check this  out');
  });

  it('strips markdown links', () => {
    expect(sanitize('See [click me](http://evil.com) for details')).toBe('See  for details');
  });

  it('strips both images and links in same string', () => {
    const input = 'Before ![img](http://a.com/x.png) middle [link](http://b.com) after';
    expect(sanitize(input)).toBe('Before  middle  after');
  });

  it('truncates to 2000 characters', () => {
    const longText = 'a'.repeat(3000);
    expect(sanitize(longText)).toHaveLength(2000);
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('handles text with no special characters', () => {
    expect(sanitize('Just normal text')).toBe('Just normal text');
  });

  it('strips nested markdown constructs (greedy inner match)', () => {
    expect(sanitize('![alt ![nested](inner)](outer)')).toBe('](outer)');
  });
});
