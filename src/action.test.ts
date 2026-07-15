import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

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

type CoreState = {
  failed: string[];
  groups: string[];
  notices: string[];
  secrets: string[];
  summary: string;
};

function createCore(overrides: Record<string, string> = {}): {
  core: CoreApi;
  state: CoreState;
} {
  const inputs: Record<string, string> = {
    'access-key': 'tza_access-key',
    'app-id': '11111111-1111-1111-1111-111111111111',
    'dry-run': 'false',
    ...overrides,
  };
  const state: CoreState = {
    failed: [],
    groups: [],
    notices: [],
    secrets: [],
    summary: '',
  };
  const summary = {
    addRaw(value: string) {
      state.summary += value;
      return summary;
    },
    async write() {
      return summary;
    },
  };
  const core = {
    getInput(name: string, options?: { required?: boolean }) {
      const value = inputs[name] ?? '';
      if (options?.required && !value) throw new Error(`${name} is required`);
      return value;
    },
    getBooleanInput(name: string) {
      return inputs[name] === 'true';
    },
    setSecret(value: string) {
      state.secrets.push(value);
    },
    setFailed(message: string | Error) {
      state.failed.push(String(message));
    },
    notice(message: string | Error) {
      state.notices.push(String(message));
    },
    startGroup(name: string) {
      state.groups.push(`start:${name}`);
    },
    endGroup() {
      state.groups.push('end');
    },
    summary,
  };
  return { core: core as unknown as CoreApi, state };
}

function workflowContext(): ActionContext {
  return {
    repo: { owner: 'example', repo: 'web-app' },
    runId: 200,
    sha: 'current-sha',
  } as unknown as ActionContext;
}

type GitHubCalls = {
  currentRun: object[];
  workflowRuns: object[];
};

function workflowGithub(
  previousRuns = [{ id: 100, head_sha: 'previous-sha' }],
): { calls: GitHubCalls; github: GitHubApi } {
  const calls: GitHubCalls = { currentRun: [], workflowRuns: [] };
  const github = {
    rest: {
      actions: {
        async getWorkflowRun(parameters: object) {
          calls.currentRun.push(parameters);
          return { data: { workflow_id: 42 } };
        },
        async listWorkflowRuns(parameters: object) {
          calls.workflowRuns.push(parameters);
          return { data: { workflow_runs: previousRuns } };
        },
      },
    },
  };
  return { calls, github: github as unknown as GitHubApi };
}

test('triggers a commit-diff test through the Tenzai API', async (t) => {
  const { core, state } = createCore();
  const { github } = workflowGithub();
  const requests: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, options: RequestInit = {}) => {
      requests.push({ url: String(url), options });
      return jsonResponse({ id: 'test-id' }, 201);
    },
  );

  await run({ core, github, context: workflowContext() });

  assert.equal(
    requests[0]?.url,
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111/tests',
  );
  assert.equal(
    new Headers(requests[0]?.options.headers).get('Authorization'),
    'Bearer tza_access-key',
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.options.body)), {
    trigger: 'MANUAL',
    profileConfig: {
      profile: 'COMMIT_DIFF',
      fromCommit: 'previous-sha',
      toCommit: 'current-sha',
    },
  });
  assert.deepEqual(state.failed, []);
  assert.deepEqual(state.secrets, ['tza_access-key']);
  assert.match(state.summary, /Tenzai test triggered/);
});

test('validates authentication and application access in dry-run mode', async (t) => {
  const { core, state } = createCore({ 'dry-run': 'true' });
  const requests: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, options: RequestInit = {}) => {
      requests.push({ url: String(url), options });
      return jsonResponse({ id: '11111111-1111-1111-1111-111111111111' });
    },
  );

  await run({
    core,
    github: {} as GitHubApi,
    context: {} as ActionContext,
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    'https://api.tenzai.io/v1/applications/11111111-1111-1111-1111-111111111111',
  );
  assert.equal(requests[0]?.options.method, 'GET');
  assert.deepEqual(state.failed, []);
  assert.match(
    state.notices[0] ?? '',
    /authentication and application access validated/,
  );
});

test('uses the GitHub SDK to detect the previous successful workflow run', async (t) => {
  const { core, state } = createCore();
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ id: 'test-id' }, 201),
  );
  const { calls, github } = workflowGithub([
    { id: 200, head_sha: 'current-sha' },
    { id: 100, head_sha: 'previous-sha' },
  ]);

  await run({ core, github, context: workflowContext() });

  assert.deepEqual(calls.currentRun, [
    { owner: 'example', repo: 'web-app', run_id: 200 },
  ]);
  assert.deepEqual(calls.workflowRuns, [
    {
      owner: 'example',
      repo: 'web-app',
      workflow_id: 42,
      status: 'success',
      per_page: 100,
    },
  ]);
  assert.match(state.summary, /`previous-sha` → `current-sha`/);
});

test('skips the first successful run of a workflow', async (t) => {
  const { core, state } = createCore();
  const { github } = workflowGithub([]);
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('fetch should not be called');
  });

  await run({ core, github, context: workflowContext() });

  assert.deepEqual(state.failed, []);
  assert.match(state.notices[0] ?? '', /No previous successful run/);
});

test('reports Tenzai API errors', async (t) => {
  const { core, state } = createCore();
  const { github } = workflowGithub();
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ detail: 'test rejected' }, 409),
  );

  await run({ core, github, context: workflowContext() });

  assert.equal(state.failed.length, 1);
  assert.match(
    state.failed[0] ?? '',
    /Tenzai test request failed \(HTTP 409\): test rejected/,
  );
});
