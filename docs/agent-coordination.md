# Agent coordination

Several agents work on one body of work at the same time. They may be running on different machines, in different checkouts, against different branches, and they may be in the same repository or in different repositories that depend on each other.

Coordination is not a courtesy between the agents. It is a set of rules about who may touch what, and this document is those rules.

## The board

The board is a single list of tasks. It is the only place where the answer to "who is working on what" lives. Nothing else answers it: not a message, not a branch name, not a claim in a chat channel.

Each entry on the board is a task record.

| Field | What it holds | Example |
| --- | --- | --- |
| Identifier | A unique name for the task, allocated by the board | `TASK-1042` |
| Title | One line describing the outcome | "Publish the weekly digest through the queue" |
| Owner | The agent or person currently working on it | `agent-scheduler` |
| Status | Where the task is in its life | `in_progress` |
| Lease expiry | When the lease runs out | `2026-01-01T10:15:00Z` |
| Paths | The files and directories the task may change | `services/api/src/digest/**` |
| Branch | The branch the work lands on | `feature/example-digest` |
| Notes | Anything the next agent needs to know | "The provider has no sandbox account yet" |

### Statuses

| Status | Meaning |
| --- | --- |
| `open` | Nobody is working on it. It may be claimed. |
| `claimed` | An agent has taken it and holds a live lease. |
| `in_progress` | The agent is making changes. |
| `in_review` | Changes are up and under review. |
| `done` | The work is merged and released. |
| `blocked` | The agent cannot continue. The notes say why and what would unblock it. |
| `abandoned` | The lease ran out and the work was not released. |

### Rules for the board

- The board is the only source of truth. If it disagrees with a message, a branch, or an agent's own memory, the board is right.
- Identifiers are allocated by the board. An agent never invents an identifier for a task. This is what stops two tasks from sharing a name.
- A task has exactly one owner at a time. Ownership moves by explicit handover, never by two agents both deciding they own it.
- Claiming a task and starting work on it are the same action. There is no window where work happens with nobody holding the lease.
- Every state change is written to the board before the work it describes begins.

## The lease is a liveness signal, not a work estimate

> The lease does not say how long the work will take. It says how long nobody has heard from the agent, after which the work may be taken away.

This distinction matters. An agent cannot know how long its work will take: it may be waiting for a network call, for a reviewer, for a service that is down, or for a human decision. If the lease were a work estimate, a slow task would hold its claim indefinitely, and a machine that crashed would hold its claim forever.

The lease therefore measures liveness, and liveness is cheap to demonstrate:

- The lease is short, on the order of minutes.
- The agent renews it while it is working, at least once per lease period.
- The renewal happens frequently enough that a crash is detected within one lease period.
- The lease is renewed by doing work, not by a timer that runs regardless. A process that is alive but stuck must lose its lease.

An agent that renews a lease from a timer without doing anything is hiding a hung agent from the board. The renewal is a side effect of the agent making progress.

## A lease that ran out is abandoned work, and may be reclaimed

> When a lease expires, the task's work is abandoned. Any agent may reclaim it, and any agent that reclaims it starts from nothing.

The rule is deliberately blunt, because the alternative is worse.

| Situation | What happens |
| --- | --- |
| The lease expired and the work was never pushed | The agent reclaims the task and starts again |
| The lease expired and the work was pushed to a branch | The agent reclaims the task and continues from the pushed branch, after checking it still applies |
| The lease expired and a branch was pushed but no longer merges | The agent reclaims the task and starts again |
| Two agents reclaim the same task at the same moment | The board records exactly one owner, because the claim is atomic. The loser reads the board, sees the other owner, and stops. |
| The original agent comes back after its lease expired | It finds the task is owned by somebody else and stops. It does not continue in the background. |

### The reclaim procedure

An agent that reclaims a task does this before touching anything:

1. Read the task record from the board, including the notes and the paths.
2. Check whether the previously claimed paths are still claimed by anybody else. If they are, the task cannot be reclaimed as-is and goes to `blocked` with a note.
3. Check whether the previous owner's branch still exists and still merges. If it does not, the work is lost and the task restarts from the description.
4. Re-claim the task with a fresh lease, and update the owner and the expiry in one write.
5. Only then begin changing files.

### The rule that makes this safe

The reclaiming agent does not trust the previous work blindly. It re-reads the files it is about to change, because the previous owner may have left them in a half-finished state. An abandoned branch is a hint, not a source of truth.

## Releasing a task

An agent releases a task when the work is finished, when it is blocked, or when it is deliberately handing it over.

Releasing means updating the board: clearing the owner, clearing the lease, setting the status, and leaving a note that says what happened and what remains.

A release note answers three questions:

| Question | Example |
| --- | --- |
| What was done | "Added the retry policy and the dead letter routing" |
| What was verified | "Unit, contract and integration layers pass; the end-to-end layer is skipped because the provider sandbox is unavailable" |
| What is left | "The dashboard for failed sends is a separate task" |

An agent that stops without releasing its task holds the lease until it expires, and the work waits for that to happen. Releasing promptly is what keeps the board moving.

## The path ownership map

The path ownership map records which task owns which paths. It is derived from the board rather than maintained separately, because two lists that are maintained by hand will disagree.

| Path | Owned by | Claimed at |
| --- | --- | --- |
| `services/api/src/digest/**` | `TASK-1042` | `2026-01-01T10:00:00Z` |
| `services/api/src/reports/**` | `TASK-1047` | `2026-01-01T10:05:00Z` |
| `packages/shared/**` | `TASK-1039` | `2026-01-01T09:50:00Z` |
| `docs/**` | `TASK-1051` | `2026-01-01T10:20:00Z` |

Rules:

- A path belongs to at most one task at a time. A path that two tasks both claim is a conflict and is resolved before either proceeds.
- A path is claimed when the task is claimed, and released when the task is released. The lease expiry releases the path.
- The granularity of a path pattern is chosen so that two tasks that touch the same file conflict with each other, and two tasks that touch different files do not.
- Broad paths are the cause of most conflicts. A path pattern that covers a whole service forces every task in that service to be serialised. Prefer the narrowest pattern that still covers the work.
- A path that no task may claim, such as a generated file or a lock file, is recorded as reserved so that a task cannot quietly claim it.

## The merge owner merges, and a build machine does not merge

> Merging is a decision made by one named owner. A machine that builds things is never the thing that merges.

| Rule | Reason |
| --- | --- |
| One merge owner per branch | Two agents merging the same branch produce a merge that neither of them reviewed |
| The merge owner is a person or a named agent, not the build pipeline | A build pipeline that merges decides by build success alone, which is not the same as being right |
| A build machine never merges | It has no context, it holds broad credentials, and an automatic merge it performs is invisible to the people who would have reviewed it |
| The merge owner is not the author of every change on the branch | If one agent wrote everything and merges it, the review did not happen |
| The merge owner checks the path ownership map before merging | A merge that silently drops another task's work is a coordination failure, not a tool failure |

The merge owner is responsible for the whole branch, including changes that other agents contributed. Before merging, the merge owner confirms that every task whose paths are touched by the branch has been released, and that no task is still in progress against those paths.

## No agent writes to another's claimed paths

> While a task holds a live lease, no other agent may create, modify, delete or move a file under that task's paths.

This is the rule that prevents two agents from editing the same file at the same time. It is enforced in three places, because a rule that is only written down is a rule that is broken eventually.

| Enforcement point | How it works |
| --- | --- |
| Before the agent starts | The agent claims the task, reads the ownership map, and checks that every path it needs is either unclaimed or already its own. A conflict stops the agent before it writes. |
| Before each write | The write helper looks up the ownership map. A write into another task's paths is refused, not warned about. |
| Before the merge | The merge owner checks the ownership map against the branch's changed paths. A path that is still claimed by an unfinished task is a reason to stop the merge. |

A change that touches another task's paths is not a violation when it is a deliberate, agreed widening of scope. In that case the ownership map is updated first, so that the other task's owner knows their paths are shared and can adjust.

## What these rules prevent

### Two agents taking the same identifier for two different tasks

**What happens.** Agent A reads the board and finds no task for "publish the weekly digest". Agent B reads the same board at the same moment and finds the same gap. Each creates a task, each allocates an identifier from the same local counter, and each starts work. The board now contains two tasks with the same identifier and different content, and every later lookup by identifier is ambiguous. One of the two sets of work is invisible to every subsequent lookup.

**Why it happens.** The identifier was allocated by a local counter instead of by the board, and the board was read once and acted on without a write that would have revealed the other claim.

**What prevents it.** The identifier is allocated by a single atomic board operation. The board rejects an identifier that is already present, and the allocation and the claim happen in the same write, so two agents cannot both believe they hold it. The board also lists the title and the owner, so a human looking at the board can see a duplicate intent even when the identifier differs.

### Two agents editing the same file at the same time

**What happens.** Agent A is rewriting a module. Agent B is adding a function to the same module. Both read the same version of the file, both write a new version of it, and the second write silently discards the first. Each agent's own test passes, because each tested its own complete version of the file. The merged result contains one of the two changes and not the other, and the loss is invisible until later.

**Why it happens.** Nothing recorded that the file was being worked on, so both agents believed they were alone in it.

**What prevents it.** The path ownership map. The file is inside a path claimed by one task, so the second agent's write is refused before it happens, and the second agent is told which task holds the path and can ask for a handover or claim a different path. The refusal happens before the file is written, so nothing is lost.

## When a conflict happens anyway

Nothing here assumes the rules are never broken. A conflict that gets through is handled in a fixed way.

| Step | Action |
| --- | --- |
| 1 | Stop. Do not merge, do not push over somebody's work, do not resolve it by force. |
| 2 | Write down which paths are affected and which tasks claim them, with timestamps. |
| 3 | Compare the two versions of the file and decide which change is missing. The usual answer is that both changes are wanted. |
| 4 | Recombine both changes deliberately, in a branch that contains both, and re-run the affected tests. |
| 5 | Update the ownership map so the path is claimed by the combined task. |
| 6 | Record what happened and why the guard did not hold. A guard that fails silently gets fixed; a guard that fails loudly and often is telling you the ownership pattern is wrong. |

## Where this fits in the wider delivery

The board is where agents and people meet. A person can claim a task, an agent can claim a task, and the rules are the same for both. The merge owner is often a person, and the on-call engineer during a release is a person.
