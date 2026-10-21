# Security policy

This repository holds blueprints, scripts and documentation. It runs in continuous
integration, it is read by people and by agents, and it holds no credentials of any
kind. Nothing in here is secret, because nothing in here is meant to be used on a
system that holds something real.

## What counts as a vulnerability

- A script that reads or writes something outside the repository it was pointed at.
- A check that can be passed by an input it should have refused, so that a finding
  about a credential, an address or a host name can be silenced.
- A workflow that asks for more permission than the job needs, or that runs something
  that was not pinned.
- A document that tells a reader to put a real credential into a public place.
- Anything that lets a change reach the default branch without the gate running.

A blueprint that does not work as described is a bug rather than a vulnerability. Report
it as a bug, through the form in `.github/ISSUE_TEMPLATE/bug_report.md`.

## How to report a vulnerability

Send the report to the private security mailbox of the project:

```text
security@example.invalid
```

That address is a placeholder on the placeholder domain of the project. The maintainer
replaces it with the real mailbox before the repository is published, and the
replacement is the only change this policy needs.

Please include:

- what the problem is, in as few words as you can;
- how to reach it, and what a reader would have to do to see it;
- what you already tried, so that the same ground is not covered twice;
- whether the problem is already public anywhere.

If you can, a proof that does no harm is worth a great deal. Please do not test
against a system that is not yours.

## What to expect

- An acknowledgement within three working days.
- An assessment within seven working days: what the problem is, how serious it is, and
  what is going to happen about it.
- A fix, or a mitigation when a fix cannot ship straight away, and a released version
  that carries it.
- A note in the changelog, so that anyone who depends on this repository can see that
  something changed.

## A report is never a public issue

A vulnerability is never filed as a public issue, not even a small one, and not even
with the interesting parts left out. A public issue is indexed, cached and mirrored
within minutes, and it cannot be unsaid.

Use the private mailbox above. If a report has to travel inside the project, use a
private channel and do not forward it to a list that includes people outside the
project.

## Credit

A fix is published with a credit to the reporter, unless the reporter asks not to be
credited. The credit says who found the problem and what version carries the fix. It
does not say anything about the reporter beyond that.

If a report is not a vulnerability, the reporter is told that, in private, with the
reason.

## No credential ever belongs in this repository

This project holds no production credentials. There is no account to manage here, no
token to renew, no key to rotate, and no address to change.

No credential may ever be pasted into an issue, a pull request, a comment, a commit
message, a document or a log. That includes the private channel, where a pasted
credential is still a credential.

If a credential ever reaches a public place, treat it as compromised:

1. rotate it with its owner, first, and not by rewriting the history;
2. remove it from the public place;
3. write down what happened and what was changed, so the same thing does not happen
   again.

The leak scanner in `scripts/scan-leaks.mjs` runs over the whole tree, on every push
and on a schedule, and it exists to catch exactly this. It is a safety net, not a
guarantee, and the rule it enforces is a human one.
