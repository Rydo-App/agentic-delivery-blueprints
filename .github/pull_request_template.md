# Pull request

## Summary

What this change does, in a few sentences: the problem it solves and what a reader
should expect to be different afterwards.

## Linked issue

The issue this change belongs to, for example issue 42. Write "none" when there is no
issue, and say why there is none.

## Type of change

- [ ] A blueprint or a document
- [ ] A script or a tool
- [ ] A workflow or a configuration
- [ ] A fix for something that was wrong
- [ ] Something else, described below

## Sensitive files

Does this change touch a migration, a lock file, an interface description,
authentication, cryptography, billing, or a deployment configuration?

- [ ] No
- [ ] Yes, and the second pair of eyes is named below

When the answer is yes, name the reviewer here and say what they checked. A change of
this kind is never merged by the author of the change.

## Checklist

- [ ] The gate ran and passed: the self-test of both tools, the leak scan, and the documentation check.
- [ ] The leak scan passed.
- [ ] The documentation checker passed.
- [ ] There is no credential and no identifier in the diff.
- [ ] There is no unrelated change in this pull request.

## Notes for the reviewer

What you want looked at, what you are unsure about, and what you could not verify. An
honest gap is worth more than a confident claim.

The merge owner merges. Nobody merges their own pull request.
