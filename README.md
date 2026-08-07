# Tenzai Test — GitHub Action

[![CI](https://github.com/TenzaiLtd/tenzai-github-action/actions/workflows/ci.yml/badge.svg)](https://github.com/TenzaiLtd/tenzai-github-action/actions/workflows/ci.yml)

Trigger an AI-powered [Tenzai](https://tenzai.io) security test after a deployment, straight from CI.

The action is **fire-and-forget**: it triggers a commit-diff test against an existing Tenzai application, and the job succeeds as soon as the test is running. Results arrive asynchronously — the Tenzai platform posts a **`Tenzai Test` check run** on the tested commit with the verdict and a full findings report when the test completes.

**Prerequisite:** create the application in the Tenzai UI first (with a target URL, code source, and any credentials the test needs), then copy its ID from the app settings page. The action does not create applications.

## Quick start

Add the action as the final step of the workflow that deploys your application:

```yaml
name: Deploy
on:
  push:
    branches: [main]

permissions:
  actions: read
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy application
        run: ./deploy.sh

      - uses: TenzaiLtd/tenzai-github-action@v1
        with:
          access-key: ${{ secrets.TENZAI_SA_TOKEN }}
          app-id: ${{ vars.TENZAI_APP_ID }}
```

The same workflow is available in [`examples/deployment-test.yml`](./examples/deployment-test.yml).

### What gets auto-detected

The action treats runs of the workflow containing it as deployment history:

| Value  | Source                                                                                       |
| ------ | -------------------------------------------------------------------------------------------- |
| `to`   | Current workflow run SHA                                                                     |
| `from` | Merge base of `to` and the most recent earlier run SHA of the same workflow, via GitHub APIs |

The merge base keeps the range on the current commit's branch line, including when the previous run came from a divergent hotfix branch. Cancelled and in-progress runs remain eligible so an intervening release is not skipped. The first run is skipped because no previous deployment exists yet. Place the action after the deployment step. Use one deployment environment per workflow; if a workflow deploys multiple environments, give each environment its own workflow.

Base-commit discovery requires `actions: read` to inspect workflow runs and `contents: read` to compare commits, as shown above.

## Discover your org and apps

If you don't yet know the `org_id`/`app-id` values to use above, run the action in list mode:

```yaml
- uses: TenzaiLtd/tenzai-github-action@v1
  with:
    access-key: ${{ secrets.TENZAI_SA_TOKEN }}
    mode: list
```

No `app-id` needed, and no `actions:`/`contents:` permissions either — list mode never inspects workflow history. It writes your organization and every application in it (ID, name, type, linked repository) to this job's Summary tab. The service-account key only needs `app:read` for this — `scan:trigger` isn't required.

The same workflow is available in [`examples/list-apps.yml`](./examples/list-apps.yml).

**Note:** on a public repository, this job's Summary tab — including your org name and every application's name/type/repository — is visible to anyone. Run this from a private repository, or restrict who can view workflow run summaries, if that inventory shouldn't be public.

## Inputs

| Input          | Required    | Default        | Description                                                                                                                                                                                                                                       |
| -------------- | ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access-key`   | ✅          | —              | Production Tenzai service-account access key (`tza_...`) with `app:read` and `scan:trigger` scopes.                                                                                                                                               |
| `app-id`       | Conditional | —              | ID of an existing Tenzai application. Required when `mode` is `trigger` (the default); unused in `mode: list`.                                                                                                                                    |
| `mode`         |             | `'trigger'`    | `trigger` triggers a commit-diff test against `app-id`. `list` looks up your organization and its applications instead.                                                                                                                           |
| `dry-run`      |             | `'false'`      | Validate configuration, authentication, and application access without triggering a test. Only meaningful with `mode: trigger`.                                                                                                                   |
| `org-id`       |             | —              | ID of the organization `app-id` belongs to. Only needed if your tenant has more than one active organization -- otherwise the platform infers it and requests fail with a 400 if it can't. Find it in the Tenzai UI's org settings.               |
| `github-token` |             | `github.token` | GitHub token used to read workflow runs and compare commits. The default workflow token is normally sufficient. Not used for API calls in `mode: list` -- the default `github.token` still works fine, just isn't read for anything in this mode. |

## Test results: the `Tenzai Test` check run

The action itself never waits for or gates on test results — the runner would be long gone before a test finishes. Instead, the **Tenzai platform** posts a check run named `Tenzai Test` on the tested commit via the Tenzai GitHub App:

- **`in_progress`** when the test starts, linking to the live test in the Tenzai UI.
- **`success` / `failure`** when the test ends, with a markdown findings report (open findings, severities, deep links) attached to the check run. The check fails when the test finds open CRITICAL or HIGH findings, or when the test itself errors.

**Prerequisites** for the check run to appear:

1. The Tenzai application's code source is connected to the tested GitHub repository.
2. The Tenzai GitHub App is installed on that repository (with Checks permission).

No write permissions are needed—the runner only reads workflow history. Tenzai posts the check run through its GitHub App.

### Gating merges

Use branch protection: mark **`Tenzai Test`** as a required status check on your protected branch. The action's own job always succeeds once the test is triggered; the platform-posted check run is what blocks or allows the merge.

## Setup

1. **Create the application** in the Tenzai UI with its target, code source (connected to your GitHub repo), and any credentials the test needs.
2. **Copy the application ID** from the app settings page and store it as a repository variable (`TENZAI_APP_ID`).
3. **Create a service-account access key** with `app:read` and `scan:trigger` scopes and store it as a repository secret (`TENZAI_SA_TOKEN`).

## Runner requirements

- A runner that supports Node 24 JavaScript actions.
- No CLI, Python, Rust, dependency installation, or `actions/checkout` setup is needed. The committed bundle talks directly to GitHub and the Tenzai API, and the test uses the application's connected code source rather than the runner workspace.

## `dry-run`

Set `dry-run: 'true'` to validate the access key and access to the configured production application without consuming a test.

## How the action connects

The action sends the service-account access key directly to the production Platform API at `api.tenzai.io` and creates a `COMMIT_DIFF` test. The test uses the targets configured on the application.

## Development

The action is written in TypeScript and ships a committed, self-contained bundle:

```bash
npm ci
npm run check
```

`npm run check` typechecks the source, runs the unit tests, and rebuilds `dist/index.js`. Commit source and bundle changes together.
