# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The blocker catalogue gained the entry on a scan that covers a tree nobody gave
  it: the symptom, the cause, the fix, the guard and the lesson.
- The test strategy states the rule for a dependency command and the tree it
  writes: a lock file is regenerated deliberately, by one command, and never by
  hand.
- The scripts guide states the contract of the staged scan, and the four rules
  that keep a scan of the tree given equal to a scan of the tree written.

### Fixed

- The leak scanner reads the tree the command was given rather than the tree
  its own file happens to live in, and every path it reports is verified to
  exist inside the tree it scanned.
- The staged scan reads the list of staged files from the repository the commit
  belongs to, the way the runner writes it, and refuses a scan of part of a
  repository rather than passing a commit it only looked at half of.
- A staged file that is not on the disk is named and fails the run, instead of
  being dropped in silence while the commit carries it.

## [0.1.0] - 2026-10-21

The first release. It is published to make the operating knowledge of multi-agent
delivery reviewable in public, with nothing identifiable in it.

### Added

- The configuration reference: what a deployment of such a stack needs configured, and
  where each kind of value belongs, including the rule that a value prefixed
  `NEXT_PUBLIC_` is inlined into the browser bundle at build time and must therefore
  never hold a secret.
- The local environment guide: bringing the stack up on a developer machine from
  nothing, and the failures that commonly stop it.
- The testing strategy: what each layer of the suite proves, what it cannot prove, and
  how to establish that a failure was already present on the base rather than
  introduced by a change.
- The deployment runbook: the stages of a release, the one-time approval that precedes
  any production change, the tagging convention, the rollback plan and the smoke test.
- The agent coordination guide: the board, leases, path ownership, who merges, and the
  two collisions this prevents.
- The blocker catalogue: the delivery failures worth knowing in advance, each with its
  symptom, cause, fix, guard and lesson.
- The sponsorship terms: what sponsorship buys, what it deliberately does not buy, and
  the transparency rules.
- `scripts/scan-leaks.mjs`: a scanner that finds the things that must not be published
  — private keys, cloud and API credentials, values that look like secrets, addresses,
  hostnames outside a small neutral list, and absolute paths — with a redacted excerpt
  and a self-test.
- `scripts/check-docs.mjs`: a checker for the documentation — headings, links, code
  fences, whitespace and the table of contents — with a self-test.
- `scripts/install-hooks.mjs`: installs the pre-commit hook that runs the scanner.
- The continuous integration workflows: the quality gate on every push and pull request,
  and the scheduled dependency and secret scan.
- The issue and pull request forms, including the blocked-task form, and the rules for
  agents taking part.
