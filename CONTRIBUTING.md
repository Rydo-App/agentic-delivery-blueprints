# Contributing

Everything in this repository is written down and reviewed, whether it was written by a
person or by an agent. The rules below are short. They exist because the failures they
prevent are the ones that do not show up in a diff.

## Before you start

- Read `README.md` and the document that covers the area you are changing.
- Read [docs/agent-coordination.md](docs/agent-coordination.md) if your change touches
  shared material, because it explains the board, the lease and the ownership of paths.
- Check the open issues. A task labelled `agent-ready` is safe to take on your own.
- If somebody else has taken the task, or has claimed the paths, stop and say so
  instead of starting. Two agents editing one file is the failure this repository is
  built to avoid.

## One logical change per commit

A commit does one thing. A fix, a document, a refactoring and a rename that happen to
be in the same file are three commits, not one. This is not tidiness: a reviewer has to
be able to read a change and understand it, and a bisect has to be able to walk
through it.

## The commit message

The convention is Conventional Commits:

```text
type: short summary in the imperative mood

Why the change is needed, in a sentence or two. What was tried, when the
obvious answer did not work. Anything a reader needs that the diff does not
show.
```

The types in use here are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`
and `ci`. The summary is written in the imperative mood, in the present tense, with no
full stop at the end. A body is added whenever the reason is not obvious from the
diff.

A commit message carries no secret and no identifier, exactly like the files do.

## The branch

A branch is named for the work:

```text
feature/short-description
fix/short-description
docs/short-description
```

An agent that takes a task from the board names its branch after the agent and the
task, so that the work in progress is visible in the list of branches:

```text
agent/agent-scheduler/TASK-1042
```

A branch is cut from the current default branch, never from an old snapshot of it.

## The gates every change has to pass

Every change passes all of these, and the output of the run is part of the pull
request:

```bash
node scripts/scan-leaks.mjs --self-test
node scripts/check-docs.mjs --self-test
node scripts/scan-leaks.mjs
node scripts/check-docs.mjs
```

The first two prove that the tools still work. The last two are the tools themselves.
The same checks run in continuous integration on every push and every pull request, so
a change that fails here fails there too, and the pull request is not ready before the
local run is green.

When the documentation changes, the table of contents in the readme changes with it.
The documentation checker fails when the two drift apart.

## A sensitive change needs a second pair of eyes

A change that touches any of the following is not merged by its author:

- a migration, in particular the number of one;
- a lock file;
- an interface description, in particular one that other agents are told to depend on;
- authentication;
- cryptography;
- billing;
- a deployment configuration.

The pull request says that it touches a sensitive file, names the person who read it
apart from the author, and says what that person checked. A reviewer who cannot check
the change says so instead of approving it.

## History and credentials

- Published history is never rewritten. No force push, no rebase of a shared branch, no
  history edit that removes a commit that somebody else has already fetched.
- A credential is never rotated without the approval of the person who owns it.
- A credential that reaches a public place is rotated with its owner, and then removed
  from the public place. It is not removed by rewriting the history, because rewriting
  the history hides the mistake instead of dealing with it.
- An agent does all of this under the same rules as a person. There is no faster path
  for a machine, and there is no slower one either.

## How an agent contributes

An agent follows the rules in [AGENTS.md](AGENTS.md), which are the same rules with the
steps spelled out for an agent. In short: read the board, take a task with a lease and
renew the lease, stay inside the paths you claimed, work on a branch, keep the two
checks green while you work, run the whole gate before you open a pull request, and
report honestly what you did not do.

An agent does not merge its own pull request. The merge owner merges.

## Reporting a security problem

A security problem is never reported in a public issue. It is reported privately, the
way [SECURITY.md](SECURITY.md) describes. No credential is ever pasted into an issue,
a pull request, a comment or a log.

## The code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) describes the behaviour expected of everyone
who takes part here, and it applies to an agent of the fleet in the same way as it
applies to a person.

## Licence

By contributing, you agree that your contribution is published under the licence of
this repository, which is the MIT licence in [LICENSE](LICENSE).
