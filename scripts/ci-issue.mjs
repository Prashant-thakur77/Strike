// One GitHub issue per failing scheduled workflow, called from actions/github-script in live-smoke.yml, keeper.yml
// and agent.yml with the workflow's own token (permissions: issues: write; no secret):
//
//   const { syncIssue } = await import(`${process.env.GITHUB_WORKSPACE}/scripts/ci-issue.mjs`);
//   await syncIssue({ github, context, core }, { title: "Live smoke failing", failed: true, body: "..." });
//
// failed: true   opens the issue, or comments on the open one with the same title (at most once per
//                minIntervalMinutes, so a job that runs every 10 minutes does not post 6 comments an hour)
// failed: false  closes the open issue, if any, with a comment naming the passing run
// The issue is found by its exact title among open issues (the list endpoint, which has no search-index delay).

/** @returns {Promise<{action: string, number?: number}>} */
export async function syncIssue(
  { github, context, core },
  { title, failed, body = "", minIntervalMinutes = 0 },
) {
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const open = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  const issue = open.find((i) => !i.pull_request && i.title === title);
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  if (!failed) {
    if (!issue) return { action: "none" };
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `Passing again at ${at}: [run ${context.runId}](${runUrl}). Closing.`,
    });
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: "completed",
    });
    core.info(`Closed #${issue.number} (${title})`);
    return { action: "closed", number: issue.number };
  }

  const text =
    `Failed at ${at}: [run ${context.runId}](${runUrl}) (${context.workflow}, ${context.eventName}).\n\n${body}`.trim();
  if (!issue) {
    const { data } = await github.rest.issues.create({
      owner,
      repo,
      title,
      body: `${text}\n\nThis issue is opened and closed by the workflow itself: it is closed by the next run that passes. Runbook: [docs/operations.md](https://github.com/${owner}/${repo}/blob/main/docs/operations.md).`,
    });
    core.warning(`Opened #${data.number} (${title})`);
    return { action: "opened", number: data.number };
  }
  const minutes = (Date.now() - new Date(issue.updated_at).getTime()) / 60_000;
  if (minutes < minIntervalMinutes) {
    core.info(
      `#${issue.number} was updated ${Math.round(minutes)} min ago; no new comment (every ${minIntervalMinutes} min at most)`,
    );
    return { action: "skipped", number: issue.number };
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: text });
  core.warning(`Commented on #${issue.number} (${title})`);
  return { action: "commented", number: issue.number };
}
