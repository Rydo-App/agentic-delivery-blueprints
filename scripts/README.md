# The code

Every tool here is a **guard**: it looks for a delivery failure before it costs
anything, and it exits non-zero when it finds one. The failures it guards against
are written up in [`../docs/blockers.md`](../docs/blockers.md), each with the
symptom, the cause, how it was found, the fix, the guard and the lesson.

None of the tools needs a dependency, and none of them needs a network. They read
a repository and report what they find.

## The tools

| Tool | What it guards against | The issue |
| --- | --- | --- |
| [`scan-leaks.mjs`](scan-leaks.mjs) | Private keys, cloud and API credentials, values that look like secrets, addresses, hostnames outside a neutral list, absolute paths — anything that must not become public. | — |
| [`check-docs.mjs`](check-docs.mjs) | A document with no heading, a link that resolves to nothing, a code fence with no language, a table of contents that does not match the files. | — |
| [`merge-check.mjs`](merge-check.mjs) | A merge that silently dropped the files only the base had. | [#2](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/2) |
| [`check-ship-line.mjs`](check-ship-line.mjs) | Two branches that both claim to be the ship line, and a branch that cannot be released because it does not carry the release workflow. | [#3](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/3), [#4](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/4) |
| [`check-migrations.mjs`](check-migrations.mjs) | A migration number used twice in two branches, a number whose order no longer means anything, a migration with no reversal. | [#6](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/6) |
| [`check-runners.mjs`](check-runners.mjs) | A workflow that names a runner which no longer exists, and a workflow that names a runner by a floating tag. | [#5](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/5) |
| [`check-tree-scope.mjs`](check-tree-scope.mjs) | A command that rewrote more of the tree than it was asked to touch. | [#11](https://github.com/Rydo-App/agentic-delivery-blueprints/issues/11) |
| [`handoff.mjs`](handoff.mjs) | A credential that leaves a machine as a value, in a message, in a log or in a commit. | — |

## Running them

Each tool runs on its own, against the repository it is in:

```bash
node scripts/scan-leaks.mjs
node scripts/check-docs.mjs
node scripts/merge-check.mjs
node scripts/check-ship-line.mjs
node scripts/check-migrations.mjs
node scripts/check-runners.mjs
node scripts/check-tree-scope.mjs
```

Every tool accepts `--help`, and most accept `--repo <dir>` to point at another
repository, `--json` to print machine-readable output, and `--quiet` to print the
findings without the closing summary.

## The exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing was found, or the self-test passed. |
| 1 | At least one finding, or a self-test failed. |
| 2 | The command line could not be understood. |

## The self-tests

Every tool carries a `--self-test` that proves its rules work: it builds a
throwaway repository with the defect the tool is meant to catch, shows that the
tool finds it, and shows that the tool stays quiet on a healthy one. The
throwaway repositories are removed afterwards.

```bash
node scripts/scan-leaks.mjs --self-test
node scripts/check-docs.mjs --self-test
```

To run the self-test of every tool at once:

```bash
npm test
```

That runner is [`run-all-tests.mjs`](run-all-tests.mjs). It picks the tools up
by their file name, so a new tool joins the suite as soon as it is written with
a `--self-test` mode.

## The pre-commit hook

The leak scan can run before every commit:

```bash
node scripts/install-hooks.mjs
```

The installer is idempotent, refuses to overwrite a hook it did not write, and
can back the old one up instead. The hook scans the staged files and refuses the
commit when it finds something. Bypassing it with `--no-verify` is possible and
is visible in the history.

## The rules the code follows

- **No dependency.** The Node standard library and `git`, and nothing else. A
  guard that needs a package to be installed is a guard that will not be run.
- **Read-only.** A tool never writes to the repository, never stages, never
  stashes, never checks out and never merges. It is safe to point at a
  repository you did not create.
- **No credential, no identifier.** The output names a path, a kind and a
  count. It never prints the content of a file, and it never prints a value
  that could be one.
- **Every rule is proven.** A rule without a sample that catches it is a rule
  nobody can trust.
