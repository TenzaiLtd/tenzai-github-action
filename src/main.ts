import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { run } from './action.js';

async function main(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  await run({
    core,
    context,
    github: getOctokit(token),
  });
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
