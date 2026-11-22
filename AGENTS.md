# Project instructions

<!-- Describe the project here: what it is, how it is laid out, conventions
     an agent needs to know. Keep this section yours; Landmark only owns the
     settings block below. -->

## Landmark settings

This repository uses the Landmark process. Agents read this block before any
phase. The process itself ships with the `landmark-*` skills; if those are not
installed, see https://github.com/alexmason/landmark.

```yaml
landmark:
  version: "0.1.0"
  branching: gitflow            # gitflow (main + dev) | trunk (main only)
  default_branch: main          # production branch
  integration_branch: dev       # under trunk: same value as default_branch
  issue_tracker: github         # github | file — decided once by landmark-init
  merge_strategy: squash        # squash | merge | rebase
  test_command: "npm run build && npm test" # e.g. "npm test"; empty means none configured
  coverage_command: "npx c8 npm test" # optional, e.g. "npm run coverage"
  dev_environment: ""           # (re)build + start local services, e.g. "docker compose up -d --build"
  manual_test_url: ""           # optional, e.g. http://localhost:3000
```

<!-- landmark:process:begin — managed by landmark-init; re-running it replaces everything up to the end marker. Put project instructions above the Landmark sections. -->

## Landmark process

This repository follows the Landmark process (https://github.com/alexmason/landmark). It applies to **every** change, however small, whether or not the user names a skill. The settings block above is authoritative.

**Before touching code**, find out where the work stands: run `landmark-status`, or read the frontmatter of `docs/plans/*.md`. Then follow the phase the work is in:

| State                                    | Do this                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| No issue for the request                 | `landmark-issue`                                            |
| Issue, no plan                           | `landmark-plan`                                             |
| Plan `draft`                             | Present it; the user approves in `landmark-plan`            |
| Plan `approved` / `implementing`         | `landmark-implement`                                        |
| Plan `implemented` / `in-review`         | `landmark-review`                                           |
| Plan `reviewed`                          | `landmark-file`                                             |
| Plan `filed`                             | Merge the PR if the user asks; then clean up                |

Rules that hold in every harness:

- **No code without an approved plan.** If the user asks for a change directly, name the phase that comes first and offer to start it; do not start coding. Never skip or reorder phases. A plan `status` that does not match the phase you are about to run is a stop-and-ask.
- **Humans gate the transitions:** plan approval, review sign-off, and the integration → production merge. Never approve, sign off, or merge to production on the user's behalf.
- **Branches and worktrees.** Work on `<type>/<n>-<slug>` branches off the integration branch, in a dedicated worktree at `../<repo>.worktrees/<type>-<n>-<slug>`. Implement, review, and file there; the main checkout stays on the integration branch. PRs target the integration branch.
- **One commit per plan step**, subject `<type>: <summary> (#<n> step <i>/<total>)`, with the ticked plan checkbox in the same commit.
- **The plan is the contract.** If it turns out to be wrong or incomplete, stop, propose an amendment, get agreement, update the plan, then continue.
- **GitHub goes through `gh`** whenever the repo has a GitHub remote (issues, PRs, comments); never `curl`, raw API calls, or browser steps.
- **Stop, don't improvise.** When a required tool is missing or a step cannot be done as written, say exactly what is missing and offer the documented alternative. Do not work around it without explicit approval.
- **State lives in the repository.** Resume from `docs/plans/` frontmatter and Git, never from memory of an earlier session.
- If the `landmark-*` skills are not installed, read the specification at https://github.com/alexmason/landmark/blob/main/docs/process.md and follow the matching phase there; do not proceed from memory.

<!-- landmark:process:end -->
