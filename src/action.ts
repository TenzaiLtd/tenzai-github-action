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
  mode: 'trigger' | 'list';
  orgId: string;
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

// Appends `?org_id=` only when set. Omitting it entirely (rather than
// sending an empty value) preserves the platform's own tenant-default
// resolution for callers that don't need to disambiguate — org-id is an
// opt-in disambiguator, not a newly-required input.
function withOrgId(url: string, orgId: string): string {
  if (!orgId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}org_id=${encodeURIComponent(orgId)}`;
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
  orgId: string,
): Promise<void> {
  await requestJson(
    withOrgId(
      platformUrl(apiBaseUrl, `applications/${encodeURIComponent(appId)}`),
      orgId,
    ),
    {
      method: 'GET',
      headers: authorizationHeaders(saToken),
    },
    'Tenzai application lookup failed',
  );
}

async function detectBaseCommit(
  github: GitHubApi,
  context: ActionContext,
  core: CoreApi,
  toCommit: string,
): Promise<string> {
  if (!context.runId) throw new Error('GitHub workflow run ID is unavailable.');

  core.startGroup('Detect base commit');
  try {
    const { data: currentRun } = await github.rest.actions.getWorkflowRun({
      ...context.repo,
      run_id: context.runId,
    });
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: currentRun.workflow_id,
      per_page: 100,
    });
    const previousRun = [...data.workflow_runs]
      .filter((candidate) => candidate.run_number < currentRun.run_number)
      .sort((left, right) => right.run_number - left.run_number)[0];
    if (!previousRun) return '';

    const { data: comparison } =
      await github.rest.repos.compareCommitsWithBasehead({
        ...context.repo,
        basehead: `${previousRun.head_sha}...${toCommit}`,
      });
    return comparison.merge_base_commit.sha;
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
      withOrgId(
        platformUrl(
          inputs.apiBaseUrl,
          `applications/${encodeURIComponent(inputs.appId)}/tests`,
        ),
        inputs.orgId,
      ),
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

type OrgSummary = { id: string; name: string; slug: string };

async function fetchOwnOrg(
  saToken: string,
  apiBaseUrl: string,
): Promise<OrgSummary> {
  const data = await requestJson(
    platformUrl(apiBaseUrl, 'organizations/mine'),
    { method: 'GET', headers: authorizationHeaders(saToken) },
    'Tenzai organization lookup failed',
  );
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error(
      `Expected exactly one organization for this service account, got ${
        Array.isArray(data) ? data.length : 'a non-array response'
      }.`,
    );
  }
  return (data as OrgSummary[])[0]!;
}

type AppSummary = {
  applicationType: string;
  id: string;
  name: string;
  repository: string | null;
};

function appSummaryFromRaw(raw: unknown): AppSummary {
  const app = raw as Record<string, unknown>;
  const code = app.code as
    { sources?: Array<{ repository?: string }> } | undefined;
  return {
    id: String(app.id),
    name: String(app.name),
    applicationType: String(
      app.applicationType ?? app.application_type ?? 'UNKNOWN',
    ),
    repository: code?.sources?.find((s) => s?.repository)?.repository ?? null,
  };
}

async function fetchAllApps(
  saToken: string,
  apiBaseUrl: string,
  orgId: string,
): Promise<AppSummary[]> {
  const apps: AppSummary[] = [];
  let page = 1;
  const size = 100;
  for (;;) {
    const data = await requestJson(
      platformUrl(
        apiBaseUrl,
        `applications?org_id=${encodeURIComponent(orgId)}&page=${page}&size=${size}`,
      ),
      { method: 'GET', headers: authorizationHeaders(saToken) },
      'Tenzai application list failed',
    );
    if (
      typeof data !== 'object' ||
      data === null ||
      !('items' in data) ||
      !Array.isArray(data.items) ||
      !('pages' in data) ||
      !Number.isInteger(data.pages)
    ) {
      throw new Error(
        'Tenzai application list response did not contain a valid items array and pages count.',
      );
    }
    const pages = data.pages as number;
    for (const raw of data.items) {
      apps.push(appSummaryFromRaw(raw));
    }
    if (page >= pages) break;
    page += 1;
  }
  return apps;
}

async function writeListSummary(
  core: CoreApi,
  org: OrgSummary,
  apps: AppSummary[],
): Promise<void> {
  const lines = [
    '### 🛡️ Tenzai — organization and applications',
    '',
    `**Organization:** ${org.name} (\`${org.id}\`)`,
    '',
  ];
  if (apps.length === 0) {
    lines.push('No applications found in this organization.');
  } else {
    lines.push(
      '| App ID | Name | Type | Repository |',
      '|---|---|---|---|',
      ...apps.map(
        (a) =>
          `| \`${a.id}\` | ${a.name} | ${a.applicationType} | ${a.repository ?? '—'} |`,
      ),
    );
  }
  await core.summary.addRaw(lines.join('\n')).write();
}

function readInputs(core: CoreApi): ActionInputs {
  const saToken = core.getInput('access-key', { required: true });
  core.setSecret(saToken);
  const rawBaseUrl = core.getInput('base-url') || DEFAULT_API_URL;
  const rawMode = core.getInput('mode') || 'trigger';
  if (rawMode !== 'trigger' && rawMode !== 'list') {
    throw new Error(
      `Unrecognized mode "${rawMode}" — must be "trigger" or "list".`,
    );
  }
  const appId = core.getInput('app-id');
  if (rawMode === 'trigger' && !appId) {
    throw new Error('app-id is required when mode is "trigger" (the default).');
  }
  return {
    saToken,
    apiBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
    appId,
    dryRun: core.getBooleanInput('dry-run'),
    mode: rawMode,
    orgId: core.getInput('org-id'),
  };
}

export async function run({
  github,
  context,
  core,
}: RunDependencies): Promise<void> {
  try {
    const inputs = readInputs(core);
    if (inputs.mode === 'list') {
      const org = await fetchOwnOrg(inputs.saToken, inputs.apiBaseUrl);
      const apps = await fetchAllApps(
        inputs.saToken,
        inputs.apiBaseUrl,
        org.id,
      );
      await writeListSummary(core, org, apps);
      core.notice(
        `Found ${apps.length} application(s) in organization ${org.id}.`,
      );
      return;
    }

    if (inputs.dryRun) {
      await validateApplication(
        inputs.saToken,
        inputs.appId,
        inputs.apiBaseUrl,
        inputs.orgId,
      );
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
    const fromCommit = await detectBaseCommit(
      github,
      context,
      core,
      context.sha,
    );
    if (!fromCommit) {
      core.notice(
        'No previous run of this workflow was found; no test triggered.',
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
