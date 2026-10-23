# Span Explorer collaboration workflow

## Current state

The shared integration branch is `codex/span-tail-lab` in `dial9-rs/dial9`.
The checkpoint contains the Span Explorer implementation, its Rust analysis
backend, and categorical latency histograms.

The user authorized the coordinator to drive all tasks through subagents,
integration, QA, and periodic demos. Assignments and feedback checkpoints are
recorded in [TASKS.md](TASKS.md). The current instruction is to merge contributions
directly into the integration branch and hold PRs until the complete feature is
ready for main. Do not open contribution PRs or a main-branch PR now.

The earlier page and histogram contribution PRs were merged before this change
in workflow. Preserve those commits and reconcile remaining worker branches
against them.

## Coordinator

1. Obtain the user's task assignment and record the scope. The active workstream
   authorizes worker pushes and coordinator integration; it does not authorize
   opening another PR.
2. Record the task's owner, branch, and status beside its entry in `TASKS.md`
   on the integration branch. The coordinator owns this ledger; workers report
   their status and exact commits to the coordinator.
3. Assign tasks 5, 8, and 9 to one owner or establish their shared layout first.
   Complete task 3 before assigning the final shared-scale work in task 7.
   Coordinate tasks 13, 17, and 18 because they share the histogram component.
4. Tasks marked with a required feedback checkpoint start with a user feedback
   conversation before implementation.
5. Review contributions and their latest validation. Merge passing, reviewed
   worker commits into the integration branch in dependency order, verify the
   combined result, then mark tasks done.
6. Keep integration commits intact so other agents can update their branches.
   Use ordinary merges or fast-forward updates for direct integration. Dependent
   workers reconcile their branches onto the resulting integration commits.
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

## Validation and direct integration

- Follow the repository's required checks for the files changed. UI changes
  need the appropriate Vitest suites, type checks, Vite build, and viewer
  embedding build. Rust behavior changes additionally need formatting,
  clippy, nextest, and the required stress run.
- Verify the affected interaction visually using representative data. Report
  the scenario, result, and material limitations. Keep production captures,
  credentials, and internal trace links out of public commits and PRs.
- Commit the contribution, push its task branch, and report the exact commit
  to the coordinator with task numbers, resulting behavior, validation, and
  any remaining concerns. **Do not open a PR.**
- The coordinator reviews the diff and merges the worker commits into
  **`codex/span-tail-lab`**. Run the required local checks and native UI QA on
  the combined result; resolve blockers before marking tasks complete.
- After an integration merge, update dependent work from the integration
  branch. Do not rewrite the shared branch's published history.

For coordinator integration of a reviewed worker branch:

```bash
git switch codex/span-tail-lab
git merge --no-ff codex/span-ui-task-01
git push origin codex/span-tail-lab
```

## Assignment template

Use only when the user is ready to start a task:

> Implement task NUMBER from `dial9-viewer/ui/docs/span-explorer/TASKS.md`.
> Read `WORKFLOW.md` and the repository instructions. Use an isolated
> worktree branched from `origin/codex/span-tail-lab` and limit changes to
> the assigned task. Run the required checks, push your branch, and report
> its exact commit and validation to the coordinator for direct integration.
> Do not open a PR, merge, or start another task. If the assigned task has a
> required feedback checkpoint, discuss it with the user before implementation.
