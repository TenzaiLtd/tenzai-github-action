import { afterEach, expect, test, vi } from 'vitest';

import {
  run,
  type ActionContext,
  type CoreApi,
  type GitHubApi,
} from './action.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockCore(overrides: Record<string, string> = {}) {
  const inputs: Record<string, string> = {
    'access-key': 'tza_access-key',
    'app-id': '11111111-1111-1111-1111-111111111111',
    'base-url': 'https://api.tenzai.io',
    'dry-run': 'false',
    mode: 'trigger',
    ...overrides,
  };
  const getInput = vi.fn(
    (name: string, options?: { required?: boolean }): string => {
      const value = inputs[name] ?? '';
      if (options?.required && !value) throw new Error(`${name} is required`);
      return value;
    },
  );
  const getBooleanInput = vi.fn(
    (name: string): boolean => inputs[name] === 'true',
  );
  const setSecret = vi.fn();
  const setFailed = vi.fn();
  const notice = vi.fn();
  const summary = {
    addRaw: vi.fn(),
    write: vi.fn(),
  };
  summary.addRaw.mockReturnValue(summary);
  summary.write.mockResolvedValue(summary);
  const core = {
    getInput,
    getBooleanInput,
    setSecret,
    setFailed,
    notice,
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    summary,
  };
  return {
    core: core as unknown as CoreApi,
    notice,
    setFailed,
    setSecret,
    summary,
  };
}

function workflowContext(): ActionContext {
  return {
    repo: { owner: 'example', repo: 'web-app' },
    runId: 200,
    sha: 'current-sha',
  } as unknown as ActionContext;
}

function mockGitHub(
  previousRuns: Array<{
    conclusion?: string;
    head_sha: string;
    id: number;
    run_number: number;
    status?: string;
  }> = [{ id: 100, head_sha: 'previous-sha', run_number: 1 }],
  mergeBaseSha = 'previous-sha',
): {
  compareCommitsWithBasehead: ReturnType<typeof vi.fn>;
  getWorkflowRun: ReturnType<typeof vi.fn>;
  github: GitHubApi;
  listWorkflowRuns: ReturnType<typeof vi.fn>;
} {
  const getWorkflowRun = vi.fn().mockResolvedValue({
    data: { workflow_id: 42, run_number: 2 },
  });
  const listWorkflowRuns = vi.fn().mockResolvedValue({
    data: { workflow_runs: previousRuns },
  });
  const compareCommitsWithBasehead = vi.fn().mockResolvedValue({
    data: { merge_base_commit: { sha: mergeBaseSha } },
  });
  const github = {
    rest: {
      actions: {
        getWorkflowRun,
        listWorkflowRuns,
      },
      repos: {
        compareCommitsWithBasehead,
      },
    },
  };
  return {
    compareCommitsWithBasehead,
    getWorkflowRun,
    github: github as unknown as GitHubApi,
    listWorkflowRuns,
  };
}

test('triggers a commit-diff test through the Tenzai API', async () => {
  vi.stubEnv('GITHUB_REPOSITORY', 'canonical/repository');
  const { core, setFailed, setSecret, summary } = mockCore();
  const { github } = mockGitHub();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ id: 'test-id' }, 201));

  await run({ core, github, context: workflowContext() });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111/tests',
  );
  expect(new Headers(options?.headers).get('Authorization')).toBe(
    'Bearer tza_access-key',
  );
  expect(JSON.parse(String(options?.body))).toEqual({
    trigger: 'MANUAL',
    profileConfig: {
      profile: 'COMMIT_DIFF',
      repository: 'canonical/repository',
      fromCommit: 'previous-sha',
      toCommit: 'current-sha',
    },
  });
  expect(setFailed).not.toHaveBeenCalled();
  expect(setSecret).toHaveBeenCalledWith('tza_access-key');
  expect(summary.addRaw).toHaveBeenCalledWith(
    expect.stringMatching(/Tenzai test triggered/),
  );
});

test('derives the repository slug from the GitHub context', async () => {
  vi.stubEnv('GITHUB_REPOSITORY', undefined);
  const { core } = mockCore();
  const { github } = mockGitHub();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ id: 'test-id' }, 201));

  await run({ core, github, context: workflowContext() });

  const [, options] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(options?.body)).profileConfig.repository).toBe(
    'example/web-app',
  );
});

test('includes org_id in the trigger request when org-id is set', async () => {
  vi.stubEnv('GITHUB_REPOSITORY', 'canonical/repository');
  const { core } = mockCore({ 'org-id': 'org-aaaa' });
  const { github } = mockGitHub();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ id: 'test-id' }, 201));

  await run({ core, github, context: workflowContext() });

  const [url] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111/tests?org_id=org-aaaa',
  );
});

test('includes org_id in the dry-run validation request when org-id is set', async () => {
  const { core } = mockCore({ 'dry-run': 'true', 'org-id': 'org-aaaa' });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      jsonResponse({ id: '11111111-1111-1111-1111-111111111111' }),
    );

  await run({
    core,
    github: {} as GitHubApi,
    context: {} as ActionContext,
  });

  const [url] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111?org_id=org-aaaa',
  );
});

test('validates authentication and application access in dry-run mode', async () => {
  const { core, notice, setFailed } = mockCore({ 'dry-run': 'true' });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      jsonResponse({ id: '11111111-1111-1111-1111-111111111111' }),
    );

  await run({
    core,
    github: {} as GitHubApi,
    context: {} as ActionContext,
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111',
  );
  expect(options?.method).toBe('GET');
  expect(setFailed).not.toHaveBeenCalled();
  expect(notice).toHaveBeenCalledWith(
    expect.stringMatching(/authentication and application access validated/),
  );
});

test('uses the merge base when the previous run is on a divergent hotfix branch', async () => {
  const { core, summary } = mockCore();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ id: 'test-id' }, 201),
  );
  const {
    compareCommitsWithBasehead,
    getWorkflowRun,
    github,
    listWorkflowRuns,
  } = mockGitHub(
    [
      { id: 200, head_sha: 'current-sha', run_number: 2 },
      { id: 100, head_sha: 'release-branch-sha', run_number: 1 },
    ],
    'common-ancestor-sha',
  );

  await run({ core, github, context: workflowContext() });

  expect(getWorkflowRun).toHaveBeenCalledWith({
    owner: 'example',
    repo: 'web-app',
    run_id: 200,
  });
  expect(listWorkflowRuns).toHaveBeenCalledWith({
    owner: 'example',
    repo: 'web-app',
    workflow_id: 42,
    per_page: 100,
  });
  expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
    owner: 'example',
    repo: 'web-app',
    basehead: 'release-branch-sha...current-sha',
  });
  expect(summary.addRaw).toHaveBeenCalledWith(
    expect.stringMatching(/`common-ances` → `current-sha`/),
  );
});

test.each([
  {
    label: 'cancelled',
    previousRun: {
      id: 100,
      head_sha: 'cancelled-sha',
      run_number: 1,
      status: 'completed',
      conclusion: 'cancelled',
    },
  },
  {
    label: 'in-progress',
    previousRun: {
      id: 100,
      head_sha: 'in-progress-sha',
      run_number: 1,
      status: 'in_progress',
    },
  },
])('uses the most recent earlier $label run', async ({ previousRun }) => {
  const { core } = mockCore();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ id: 'test-id' }, 201),
  );
  const { compareCommitsWithBasehead, github } = mockGitHub([
    {
      id: 300,
      head_sha: 'later-run-sha',
      run_number: 3,
      status: 'in_progress',
    },
    previousRun,
  ]);

  await run({ core, github, context: workflowContext() });

  expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
    expect.objectContaining({
      basehead: `${previousRun.head_sha}...current-sha`,
    }),
  );
});

test('skips the first run of a workflow', async () => {
  const { core, notice, setFailed } = mockCore();
  const { github } = mockGitHub([]);
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await run({ core, github, context: workflowContext() });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(setFailed).not.toHaveBeenCalled();
  expect(notice).toHaveBeenCalledWith(expect.stringMatching(/No previous run/));
});

test('uses custom base-url for API calls and summary links', async () => {
  const { core, setFailed, summary } = mockCore({
    'base-url': 'https://api.staging.tenzai.io',
  });
  const { github } = mockGitHub();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ id: 'test-id' }, 201));

  await run({ core, github, context: workflowContext() });

  const [url] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    'https://api.staging.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111/tests',
  );
  expect(setFailed).not.toHaveBeenCalled();
  expect(summary.addRaw).toHaveBeenCalledWith(
    expect.stringContaining('app.staging.tenzai.io'),
  );
});

test('reports Tenzai API errors', async () => {
  const { core, setFailed } = mockCore();
  const { github } = mockGitHub();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ detail: 'test rejected' }, 409),
  );

  await run({ core, github, context: workflowContext() });

  expect(setFailed).toHaveBeenCalledOnce();
  expect(setFailed).toHaveBeenCalledWith(
    'Tenzai test request failed (HTTP 409): test rejected',
  );
});

test('rejects an unrecognized mode value without calling fetch', async () => {
  const { core, setFailed } = mockCore({ mode: 'oops' });
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(/mode.*trigger.*list|trigger.*list.*mode/i),
  );
});

test('defaults mode to trigger, preserving existing behavior', async () => {
  vi.stubEnv('GITHUB_REPOSITORY', 'canonical/repository');
  const { core, setFailed } = mockCore();
  const { github } = mockGitHub();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ id: 'test-id' }, 201),
  );

  await run({ core, github, context: workflowContext() });

  expect(setFailed).not.toHaveBeenCalled();
});

test('mode: trigger with no app-id fails loudly', async () => {
  const { core, setFailed } = mockCore({ mode: 'trigger', 'app-id': '' });
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(setFailed).toHaveBeenCalledWith(expect.stringMatching(/app-id/));
});

function orgSummary(
  overrides: Partial<{ id: string; name: string; slug: string }> = {},
) {
  return {
    id: 'org-1111-1111-1111-111111111111',
    name: 'Acme Security',
    slug: 'acme-security',
    ...overrides,
  };
}

test('mode: list writes the org and every app across pages to the summary', async () => {
  const { core, setFailed, summary } = mockCore({ mode: 'list', 'app-id': '' });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse([orgSummary()]))
    .mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: 'app-1',
            name: 'App One',
            applicationType: 'WEB_APP',
            code: {
              sources: [{ repository: 'https://github.com/acme/app-one' }],
            },
          },
        ],
        total: 2,
        page: 1,
        pages: 2,
        size: 1,
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: 'app-2', name: 'App Two', applicationType: 'NETWORK_HOST' },
        ],
        total: 2,
        page: 2,
        pages: 2,
        size: 1,
      }),
    );

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(String(fetchMock.mock.calls[0]![0])).toBe(
    'https://api.tenzai.io/v1/organizations/mine',
  );
  expect(String(fetchMock.mock.calls[1]![0])).toContain(
    `applications?org_id=${orgSummary().id}&page=1&size=100`,
  );
  expect(String(fetchMock.mock.calls[2]![0])).toContain('page=2');
  const written = String(summary.addRaw.mock.calls[0]![0]);
  expect(written).toContain('Acme Security');
  expect(written).toContain('app-1');
  expect(written).toContain('app-2');
  expect(written).toContain('https://github.com/acme/app-one');
});

test('mode: list with zero applications reports that plainly, not as an error', async () => {
  const { core, setFailed, summary } = mockCore({ mode: 'list', 'app-id': '' });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse([orgSummary()]))
    .mockResolvedValueOnce(
      jsonResponse({ items: [], total: 0, page: 1, pages: 1, size: 100 }),
    );

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).not.toHaveBeenCalled();
  expect(String(summary.addRaw.mock.calls[0]![0])).toContain(
    'No applications found',
  );
});

test('mode: list throws if /organizations/mine returns anything but exactly one org', async () => {
  const { core, setFailed } = mockCore({ mode: 'list', 'app-id': '' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(/exactly one organization/),
  );
});

test('mode: list propagates a bad access-key as a failure', async () => {
  const { core, setFailed } = mockCore({ mode: 'list', 'app-id': '' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    jsonResponse({ detail: 'Invalid access key' }, 401),
  );

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(
      /organization lookup failed.*401.*Invalid access key/is,
    ),
  );
});

test('mode: list throws if /organizations/mine returns more than one org', async () => {
  const { core, setFailed } = mockCore({ mode: 'list', 'app-id': '' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    jsonResponse([orgSummary(), orgSummary({ id: 'org-2222' })]),
  );

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(/exactly one organization/),
  );
});

test('mode: list propagates a 401 from the applications fetch, not just the org fetch', async () => {
  const { core, setFailed } = mockCore({ mode: 'list', 'app-id': '' });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse([orgSummary()]))
    .mockResolvedValueOnce(jsonResponse({ detail: 'Invalid access key' }, 401));

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(/application list failed.*401.*Invalid access key/is),
  );
});

test('mode: list fails fast instead of looping forever when the applications response has no numeric pages', async () => {
  const { core, setFailed } = mockCore({ mode: 'list', 'app-id': '' });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse([orgSummary()]))
    .mockResolvedValueOnce(jsonResponse({ items: [] }));

  await run({ core, github: {} as GitHubApi, context: {} as ActionContext });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringMatching(/items array and pages count/),
  );
});
