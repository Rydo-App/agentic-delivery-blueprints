# Scripts

Three small programs, written with nothing but the Node standard library. They
run the same way on Linux, macOS and Windows, they need no installation step,
and each of them can prove that it still works.

| Script | What it does |
| --- | --- |
| [scan-leaks.mjs](scan-leaks.mjs) | Finds anything in the tree that must not be published. |
| [check-docs.mjs](check-docs.mjs) | Checks the markdown: headings, links, whitespace, code fences, table of contents. |
| [install-hooks.mjs](install-hooks.mjs) | Installs the managed pre-commit hook. |

## Running them

```bash
# find anything that must not be published
node scripts/scan-leaks.mjs

# check the documentation
node scripts/check-docs.mjs

# prove that the tools themselves still work
node scripts/scan-leaks.mjs --self-test
node scripts/check-docs.mjs --self-test

# install the pre-commit hook
node scripts/install-hooks.mjs
```

Both checkers exit non-zero when they find something, so they can be used as a
gate in a pipeline. The scanner also understands `--json` for machine use,
`--quiet` to leave out the closing summary, `--staged` to look only at the
files that are staged for the next commit, and `--help` for the full list.

## The tree the scanner reads is the tree it was given

> The tree a tool is given and the tree it writes must be the same tree.

The scanner reads the repository that contains the directory the command was
called from, or that directory itself when the call site is not inside a
repository. It never reads the directory its own file happens to live in: a
scanner that is copied somewhere else on one machine would otherwise scan that
other place and answer a question nobody asked. `--root` names a tree
explicitly, and a path given on the command line that does not lie inside the
tree given is refused rather than followed.

The tree the scanner reports is the same tree. Every path it prints is checked
to exist inside the tree that was scanned, and a path that does not is a defect
of the scanner rather than a finding, so the run fails instead of printing a
reference to a file that is not there.

## What the staged scan does

The staged scan answers one question: does the next commit carry anything that
must not be published? To answer it, the scanner needs the list of staged
files, and it reads that list from the repository the commit belongs to. The
paths in that list are written relative to the top of the repository, which is
not always the tree that was given, so they are placed against the top of the
repository first and against the tree given afterwards.

Four rules follow from that, and the self-test proves each of them in a
temporary repository:

| Rule | What it stops |
| --- | --- |
| A staged scan covers the whole commit or it covers nothing, so a scan of part of a repository is refused | A commit that passes because only the convenient half of it was looked at |
| A staged file the tree does not hold is named, and the run fails | A commit that carries content no scan was able to read |
| A staged path that belongs to another tree is counted and named, never folded into a path that is not there | A finding that belongs to a file the commit does not carry |
| A lock file is excluded, the way the whole-tree scan excludes it | A tree that answers a different question depending on the mode it was asked in |

A lock file is regenerated deliberately, by the one command that owns it, and it
is never edited by hand. A change to one is reviewed as a change of the locked
versions, through the dependency tooling, and not as a change of the files.

## The self-test is what makes the scanner trustworthy

`--self-test` runs every pattern against a small set of samples that are known
to be good and samples that are known to be bad. The run fails when a pattern
does not catch its bad sample, when a pattern fires on a good sample, when a
good sample of one pattern trips another pattern, or when a pattern prints a
value in full. A scanner that cannot show its own work is a scanner nobody
should trust, so the self-test runs in continuous integration on every push
and every pull request.

## The scanner does not report itself

This is a documented exception, and it is the only one.

The scanner has to look for words such as `api_key`, `secret`, `password` and
`token` followed by something that looks like a value. Those words, and the
patterns that match them, live in the source of the scanner itself. If the
scanner read its own source the way it reads every other file, it would report
itself on every run, and the finding would be a line of regular expression
rather than a leak.

So the scanner skips its own source file, and it skips a copy of itself that
is found under another name. Nothing else is skipped: every other file in the
tree, including this one, is read exactly like any other file.

The other tools have the same shape of exception. `check-docs.mjs` reads this
file and finds exactly one top level heading, no tab character, no trailing
whitespace, a language tag on every code block and one link that resolves.

## What the scanner looks for

| Pattern | What it is |
| --- | --- |
| `private-key-block`, `pem-header` | A block that holds key material. |
| `cloud-access-key-id`, `aws-account-id`, `arn-with-account-id` | A cloud identifier. |
| `bearer-token`, `json-web-token`, `github-token`, `slack-token`, `google-api-key`, `stripe-secret-key` | A token of a known shape. |
| `secret-assignment` | A setting whose value looks like a real value rather than a placeholder. |
| `email-address` | An address on a domain that is not accepted. |
| `ipv4-address` | An address outside the loopback and the documentation ranges. |
| `absolute-path` | A path that belongs to one machine. |
| `unknown-hostname` | A host name outside the accepted list of public domains. |

A finding is printed as one line, with the file, the line number, the name of
the pattern and a redacted excerpt. The excerpt shows at most the first four
characters and the last two characters of a value, and nothing at all for key
material. The secret is never printed in full, not even in the output of the
scanner.

## The hook

`install-hooks.mjs` writes a pre-commit hook that runs the scanner over the
files that are staged for the commit and refuses the commit when the scanner
finds something. It is idempotent, and it never overwrites a hook it did not
write: it says so, and it offers to move the existing hook aside first.

The hook changes to the top of the repository before it runs the scanner, so the
tree the scan covers is the tree the commit belongs to. A hook that ran the
scanner from anywhere else would be judging a commit by a tree it was never
given.
