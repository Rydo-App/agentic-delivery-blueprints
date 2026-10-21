# Agent rules

These are the rules an AI agent follows when it works in this repository. They are the
same rules the people follow, with the steps spelled out for an agent. Where they
differ, the difference is never in what is allowed and only in how it is done.

1. **Read the board before you claim anything.** Open
   [docs/agent-coordination.md](docs/agent-coordination.md) and read the board, the
   lease and the ownership of paths before you take anything. The board is the only
   place that answers who is working on what. It exists to stop two failures: two
   agents taking the same identifier for two different tasks, and two agents editing
   the same file at the same time.

2. **Take a task with a lease, and renew the lease.** Claim the task on the board with
   your identifier, the paths you are going to touch, and the moment your lease runs
   out. Renew it while you are still working. If the task turns out to be bigger than
   the lease, say so on the board instead of letting the lease run out quietly.

3. **Stay inside the paths you claimed.** Change the paths your task names and nothing
   else. If the task needs a path you did not claim, stop, widen the claim on the
   board, and wait until the claim is granted.

4. **Never touch another agent's claimed paths.** Another agent's work is not
   available space. If you need something they own, ask on the board. If their lease
   has expired and the board says so, it may be reclaimed in the open, never by
   deleting their work.

5. **Work on a branch, never on the default branch.** Cut the branch from the current
   default branch, not from an old snapshot of it. Name it after the work, and after
   your agent and the task when the work comes from the board.

6. **Never commit to the default branch.** The default branch is the one the merge
   owner merges into. A commit that lands there directly is a change nobody reviewed.

7. **Never force a push.** A force push replaces work that somebody else may already
   have fetched. If a push is rejected, the answer is to look at what happened, not to
   overwrite it.

8. **Never rewrite published history.** No force push, no rebase of a branch that
   somebody else has fetched, no history edit that removes a commit. If a credential
   has to be removed from the history, it is rotated with its owner instead, and the
   history is left alone.

9. **Never write a credential or an identifier into a file or a commit message.** Not
   a key, not a token, not an address, not a host name, not a number that identifies
   something, and not an absolute path that belongs to one machine. Use the
   placeholder forms the documentation uses, and keep every command relative to the
   root of the repository.

10. **Never change a credential or a rotation without the approval of its owner.** The
    owner rotates it, and the rotation is written down as a change, not as an edit of
    a value in place.

11. **Keep the leak scanner and the documentation checker green as you go.** Run them
    while you work, not once at the end:

    ```bash
    node scripts/scan-leaks.mjs
    node scripts/check-docs.mjs
    ```

    A finding is either a problem in your change or a problem in the tool. It is never
    a reason to leave it there.

12. **Keep the documentation with the code.** When the set of documents changes, change
    the table of contents in the readme in the same commit. The documentation checker
    fails when the two drift apart, and it is right to fail.

13. **Run the whole gate before you open a pull request.** The self-test of both tools
    comes first, because a tool that no longer works proves nothing:

    ```bash
    node scripts/scan-leaks.mjs --self-test
    node scripts/check-docs.mjs --self-test
    node scripts/scan-leaks.mjs
    node scripts/check-docs.mjs
    ```

    Put the output in the pull request.

14. **Ask for a second pair of eyes when the change is sensitive.** A migration, a
    lock file, an interface description, authentication, cryptography, billing, or a
    deployment configuration: say so in the pull request, name the reviewer, and say
    what that reviewer checked. Do not merge it yourself.

15. **Never merge your own pull request.** The merge owner merges. You open the pull
    request, you answer the review, and you wait.

16. **Report honestly what was not done and what is still unverified.** Say what you
    did, what you checked and what the output was, and say plainly what you did not
    do. An unverified claim is worse than an honest gap, because an honest gap can be
    closed by somebody else.

17. **Report a blocker in the shape of the blocker guide.** A blocker report takes the
    form in `.github/ISSUE_TEMPLATE/blocked_task.md`: the symptom, the cause, how it
    was found, the fix, the guard and the lesson. It is the same shape as
    [docs/blockers.md](docs/blockers.md), and a good report there usually becomes an
    entry in it.

18. **Follow the general rules too.** The commit convention, the branch naming, the
    gates and the sensitive-change rule are in
    [CONTRIBUTING.md](CONTRIBUTING.md), the behaviour expected of everybody is in
    [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and a security problem is reported the
    way [SECURITY.md](SECURITY.md) describes, never as a public issue.
