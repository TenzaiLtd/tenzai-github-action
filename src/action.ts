import type * as actionsCore from '@actions/core';
import type { context as actionsContext, getOctokit } from '@actions/github';

const DEFAULT_API_URL = 'https://api.tenzai.io';

export type CoreApi = typeof actionsCore;
export type ActionContext = typeof actionsContext;
export type GitHubApi = ReturnType<typeof getOctokit>;

type RunDependencies = {
  core: CoreApi;
  context: ActionContext;
  github: GitHubApi;
};

type ActionInputs = {
  apiBaseUrl: string;
  appId: string;
  dryRun: boolean;
  saToken: string;
};

function errorDetail(data: unknown): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    'detail' in data &&
    typeof data.detail === 'string'
  ) {
    return `: ${data.detail}`;
  }
  return '';
}

async function requestJson(
  url: string,
  options: RequestInit,
  label: string,
): Promise<unknown> {
  const response = await globalThis.fetch(url, options);
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${label} (HTTP ${response.status})${errorDetail(data)}`);
  }
  return data;
}

function appUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace('://api.', '://app.');
}

function platformUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl}/v1/${path}`;
}

function authorizationHeaders(saToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${saToken}`,
    'Content-Type': 'application/json',
  };
}

async function validateApplication(
  saToken: string,
  appId: string,
  apiBaseUrl: string,
): Promise<void> {
  await requestJson(
    platformUrl(apiBaseUrl, `applications/${encodeURIComponent(appId)}`),
    {
      method: 'GET',
      headers: authorizationHeaders(saToken),
    },
    'Tenzai application lookup failed',
  );
}

async function detectPreviousWorkflowCommit(
  github: GitHubApi,
  context: ActionContext,
  core: CoreApi,
): Promise<string> {
  if (!context.runId) throw new Error('GitHub workflow run ID is unavailable.');

  core.startGroup('Detect previous workflow run');
  try {
    const { data: currentRun } = await github.rest.actions.getWorkflowRun({
      ...context.repo,
      run_id: context.runId,
    });
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: currentRun.workflow_id,
      status: 'success',
      per_page: 100,
    });
    return (
      data.workflow_runs.find((candidate) => candidate.id !== context.runId)
        ?.head_sha ?? ''
    );
  } finally {
    core.endGroup();
  }
}

async function triggerTest(
  saToken: string,
  inputs: ActionInputs,
  repository: string,
  fromCommit: string,
  toCommit: string,
  core: CoreApi,
): Promise<string> {
  core.startGroup('Trigger commit-diff test');
  try {
    const data = await requestJson(
      platformUrl(inputs.apiBaseUrl, `applications/${encodeURIComponent(inputs.appId)}/tests`),
      {
        method: 'POST',
        headers: authorizationHeaders(saToken),
        body: JSON.stringify({
          trigger: 'MANUAL',
          profileConfig: {
            profile: 'COMMIT_DIFF',
            repository,
            fromCommit,
            toCommit,
          },
        }),
      },
      'Tenzai test request failed',
    );
    if (
      typeof data !== 'object' ||
      data === null ||
      !('id' in data) ||
      typeof data.id !== 'string' ||
      !data.id
    ) {
      throw new Error('Tenzai test response did not contain an id.');
    }
    return data.id;
  } finally {
    core.endGroup();
  }
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function repositorySlug(context: ActionContext): string {
  return (
    process.env.GITHUB_REPOSITORY ||
    `${context.repo.owner}/${context.repo.repo}`
  );
}

async function writeSummary(
  core: CoreApi,
  inputs: ActionInputs,
  fromCommit: string,
  toCommit: string,
  test: { id: string; url: string } | null,
  headline: string,
): Promise<void> {
  const rows = [`| Application | ${inputs.appId} |`];
  if (fromCommit && toCommit) {
    rows.push(
      `| Commit range | \`${shortCommit(fromCommit)}\` → \`${shortCommit(toCommit)}\` |`,
    );
  }
  if (test) rows.push(`| Test | [${test.id}](${test.url}) |`);

  const lines = [`### ${headline}`, '', '| | |', '|---|---|', ...rows, ''];
  if (test) {
    lines.push(
      "The verdict and findings report will appear on this commit's **Tenzai Test** check run when the test completes.",
      '',
    );
  }
  await core.summary.addRaw(lines.join('\n')).write();
}

function readInputs(core: CoreApi): ActionInputs {
  const saToken = core.getInput('access-key', { required: true });
  core.setSecret(saToken);
  const rawBaseUrl = core.getInput('base-url') || DEFAULT_API_URL;
  return {
    saToken,
    apiBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
    appId: core.getInput('app-id', { required: true }),
    dryRun: core.getBooleanInput('dry-run'),
  };
}

export async function run({
  github,
  context,
  core,
}: RunDependencies): Promise<void> {
  try {
    const inputs = readInputs(core);
    if (inputs.dryRun) {
      await validateApplication(inputs.saToken, inputs.appId, inputs.apiBaseUrl);
      core.notice(
        'dry-run: authentication and application access validated; no test triggered.',
      );
      await writeSummary(
        core,
        inputs,
        '',
        '',
        null,
        '🛡️ Tenzai test — dry-run (no test triggered)',
      );
      return;
    }

    if (!context.sha) {
      throw new Error('GitHub workflow commit SHA is unavailable.');
    }
    const fromCommit = await detectPreviousWorkflowCommit(
      github,
      context,
      core,
    );
    if (!fromCommit) {
      core.notice(
        'No previous successful run of this workflow was found; no test triggered.',
      );
      await writeSummary(
        core,
        inputs,
        '',
        context.sha,
        null,
        '🛡️ Tenzai test skipped — no previous workflow run',
      );
      return;
    }
    const testId = await triggerTest(
      inputs.saToken,
      inputs,
      repositorySlug(context),
      fromCommit,
      context.sha,
      core,
    );
    const testUrl = `${appUrl(inputs.apiBaseUrl)}/apps/${encodeURIComponent(inputs.appId)}/tests/${encodeURIComponent(testId)}`;
    const test = { id: testId, url: testUrl };

    core.notice(`Triggered commit-diff test ${testId}: ${testUrl}`);
    await writeSummary(
      core,
      inputs,
      fromCommit,
      context.sha,
      test,
      '🛡️ Tenzai test triggered',
    );
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
