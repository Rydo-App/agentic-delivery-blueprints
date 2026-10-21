---
name: Blocked task
about: A task cannot be finished, and the reason is worth writing down
title: ''
labels: blocked
assignees: ''
---

# Blocked task

Use this form when a task cannot be finished. A blocker that is written down is
worth a great deal more than a blocker that is only described in a chat, because the
next person to hit it will recognise it.

This is the same shape as the blocker guide in [docs/blockers.md](../../docs/blockers.md),
and a good report here usually becomes an entry there.

## Symptom

What you observed, in the order you observed it. What was expected to happen, what
happened instead, and how visible the difference was. Say plainly whether anything
failed loudly, because the worst blockers are the ones that fail quietly.

## Cause

Why it happened, as far as you could establish it. Name the mechanism rather than the
feeling: the branch that had drifted, the selector that matched two branches, the
file that was generated instead of written. If the cause is not known yet, say what has
been ruled out and what is still open.

## How it was found

What made it visible: a test that went red, a comparison of two trees, a record of
two different versions in the same place, or a human who noticed. Say how it was found
as well as what was found, because the way it was found is often the guard that should
have existed.

## Fix

What you did to get past it, if you did. If the task is still blocked, say what is
missing and who can provide it. A fix that was applied but not kept is worth
describing exactly as it is.

## Guard

What stops this from happening again, in a way someone else can check. A pipeline step,
a check in the checker, a rule in the guide, a warning that fails the build. A guard
that depends on everyone remembering is not a guard.

## Lesson

The one sentence that is worth reading a year from now. What to look for, what to
write down, what to compare, and what to ask before starting.

## Notes

Anything else, including links to other issues or to a part of the documentation that
describes the same thing.

Please do not paste a credential, a token, a key, an address, a hostname, or any other
detail that identifies a real system into this issue. Use the placeholder forms the
documentation uses instead.
