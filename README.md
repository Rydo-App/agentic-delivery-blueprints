# Agentic Delivery Blueprints

A public, reusable reference for teams that let **AI agents deliver software** across
several machines and several repositories, without the agents colliding with each other
and without anything sensitive reaching the public internet.

The material here is the part that is hard to rediscover: how to hand work to an agent,
how to stop two agents from taking the same task, how to tell a failure that was already
there from one a change introduced, and how to get a release out of a machine that runs
production.

Everything here is written generically. There are no credentials, no addresses, no
customer names and no details of any specific system in this repository, and there is a
scanner in `scripts/` that enforces exactly that.

## Who this is for

- A team running one agent per area of a codebase, on separate machines, in parallel.
- A team that has been bitten by a merge that silently dropped files, by two branches
  that both claimed to be the ship line, or by a migration number that was used twice.
- A team that wants the operating knowledge of multi-agent delivery to be written down
  and reviewable, rather than living in the heads of whoever set it up.

## What is in here

<!-- toc -->

| Document | What it answers |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | What a deployment of such a stack needs configured, and where each kind of value belongs. |
| [docs/local-environment.md](docs/local-environment.md) | How to bring the stack up on a developer machine from nothing, and what commonly goes wrong. |
| [docs/testing.md](docs/testing.md) | What each layer of the test suite proves, and how to prove a failure was already there. |
| [docs/deployment.md](docs/deployment.md) | How a release moves from preparation to staging to production, and how it is rolled back. |
| [docs/agent-coordination.md](docs/agent-coordination.md) | How several agents share one body of work without colliding. |
| [docs/blockers.md](docs/blockers.md) | The delivery blockers worth knowing in advance, each with its cause, fix and guard. |
| [docs/sponsorship.md](docs/sponsorship.md) | What sponsoring this project buys, and what it deliberately does not. |

| File | What it is |
| --- | --- |
| [AGENTS.md](AGENTS.md) | The rules an AI agent follows when it works in this repository. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How a change is made here, by a person or by an agent. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | The behaviour expected of everyone taking part. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability privately. |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and when. |

## The two tools

```bash
# find anything that must not be published
node scripts/scan-leaks.mjs

# check the documentation: headings, links, code fences, the table of contents
node scripts/check-docs.mjs

# prove the tools themselves still work
node scripts/scan-leaks.mjs --self-test
node scripts/check-docs.mjs --self-test

# install the pre-commit hook, so the scanner runs before every commit
node scripts/install-hooks.mjs
```

The scanner looks for private keys, cloud and API credentials, values that look like
secrets, addresses, hostnames outside a small neutral list, absolute paths and anything
else that must not become public. It prints a redacted excerpt, never the secret itself.
Both tools run in continuous integration on every push and pull request, and the
scanner also runs on a schedule.

## Why an open reference

Multi-agent delivery goes wrong in ways that are invisible in a diff: a merge that
dropped a file only the base had still compiles and still passes its tests; a workflow
that names a runner which no longer exists reports a failure that has nothing to do
with the change; a migration number used twice in two branches runs in the order of the
file names rather than the order of the numbers.

Those failures are worth writing down once, carefully, in public, with nothing
identifiable in them. That is the whole purpose of this repository.

## Agents work here

Agents take part in this repository under the same rules as people, and the rules are
written down in [AGENTS.md](AGENTS.md). In short: read the board before claiming
anything, hold a lease on what you take, never touch the paths another agent has
claimed, never commit to the default branch, never force a push, never rewrite published
history, and never write a credential or an identifier into a file or a commit message.

Issues labelled `agent-ready` are safe for an agent to pick up on its own. The
[blocked-task form](.github/ISSUE_TEMPLATE/blocked_task.md) is the shape a blocker
report should take: the symptom, the cause, how it was found, the fix, the guard, and the
lesson.

## Sponsorship

Sponsorship pays for maintainer time, for faster review, and for the hosted runners the
continuous integration needs. It buys **no** influence over the order of the backlog, no
private support channel, and no feature in exchange for money. The full terms, the
levels, the transparency rules and how a sponsorship is withdrawn are in
[docs/sponsorship.md](docs/sponsorship.md).

## Licence

[MIT](LICENSE). See [LICENSE](LICENSE) for the full text.
