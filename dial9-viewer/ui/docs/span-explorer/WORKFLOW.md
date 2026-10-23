# Span Explorer collaboration workflow

## Current state

The shared integration branch is `codex/span-tail-lab` in `dial9-rs/dial9`.
The checkpoint contains the Span Explorer implementation, its Rust analysis
backend, and categorical latency histograms.

The user authorized the coordinator to drive all tasks through subagents,
integration, QA, and periodic demos. Assignments and feedback checkpoints are
recorded in [TASKS.md](TASKS.md). Contribution PRs target the integration branch;
a main-branch PR or deployment remains a separate step.

## Coordinator

1. Obtain the user's task assignment, including permission to push and open a
   contribution PR. Use the assignment template below to make the scope clear.
2. Record the task's owner, branch, and status beside its entry in `TASKS.md`
   on the integration branch. The coordinator owns this ledger; workers report
   their status in their PRs.
3. Assign tasks 5, 8, and 9 to one owner or establish their shared layout first.
   Complete task 3 before assigning the final shared-scale work in task 7.
   Coordinate tasks 13, 17, and 18 because they share the histogram component.
4. Tasks marked with a required feedback checkpoint start with a user feedback
   conversation before implementation.
5. Review contributions and their latest validation. Merge passing, reviewed
   PRs into the integration branch in dependency order, then mark tasks done.
6. Keep integration commits intact so other agents can update their branches.
   A main-branch PR or deployment is a separate user-authorized step.

## Worker branches

Work in the upstream `dial9` repository. Use an isolated worktree and one
branch per assigned batch; group tasks that affect the same component. Do not
share a dirty checkout or push directly to
the integration branch.

From the upstream checkout, after assignment:

```bash
git fetch origin
git worktree add -b codex/span-ui-task-01 \
  ../dial9-span-ui-task-01 origin/codex/span-tail-lab
```

Use the assigned task number and a unique suffix when necessary. Read the
root `AGENTS.md`, `dial9-viewer/AGENTS.md`, this workflow, and the assigned
task's completion criteria. Follow any additional metarepo instructions when
working through that workspace.

Keep changes within the assigned task. Numeric field presentation mainly
lives in `dial9-viewer/ui/src/pages/span-explorer/tail-analysis.ts` and its
stylesheet; categorical rendering lives beside it in
`categorical-histograms.ts`; backend reports live in
`dial9-viewer/src/server/span_stats/tail.rs`. Coordinate overlapping edits
before work starts. Analysis remains in Rust.

## Validation and contribution

- Follow the repository's required checks for the files changed. UI changes
  need the appropriate Vitest suites, type checks, Vite build, and viewer
  embedding build. Rust behavior changes additionally need formatting,
  clippy, nextest, and the required stress run.
- Verify the affected interaction visually using representative data. Report
  the scenario, result, and material limitations. Keep production captures,
  credentials, and internal trace links out of public commits and PRs.
- Commit the contribution, push its task branch, and open a PR with
  **`codex/span-tail-lab` as the base**. Include the task number, resulting
  behavior, validation, and any remaining questions.
- Wait for CI on the latest contribution commit, resolve blocking failures
  within the assigned scope, and notify the coordinator when ready.
- After an integration merge, update dependent work from the integration
  branch. Do not rewrite the shared branch's published history.

For an authorized contribution, the PR command is:

```bash
gh pr create --base codex/span-tail-lab \
  --head codex/span-ui-task-01 \
  --title "Task 1: describe the resulting behavior" \
  --body-file /tmp/span-ui-task-01-pr.md
```

## Assignment template

Use only when the user is ready to start a task:

> Implement task NUMBER from `dial9-viewer/ui/docs/span-explorer/TASKS.md`.
> Read `WORKFLOW.md` and the repository instructions. Use an isolated
> worktree branched from `origin/codex/span-tail-lab` and limit changes to
> the assigned task. Push your branch and open a PR targeting
> `codex/span-tail-lab`; wait for its latest CI and report validation to
> the coordinator. Do not merge or start another task. If the assigned task
> has a required feedback checkpoint, ask the user before implementation.
