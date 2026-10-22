#!/usr/bin/env node
/**
 * check-tree-scope.mjs — a tree scope checker for a repository.
 *
 * A command run to refresh one lock file also changes files nobody intended
 * to change, and the pull request carries a hundred unrelated lines. The
 * cause is that the command regenerates from the tree rather than from the
 * tree it was given, and the scanner it uses matches paths differently from
 * the way the runner writes them.
 *
 * The checker compares the working tree with a base, lists the paths that
 * changed, and sorts them into two piles:
 *
 *   - the paths the caller declared as expected, which are the only changes
 *     that are allowed;
 *   - the paths that changed anyway, which are the finding.
 *
 * On top of that it reports:
 *
 *   - a file that was added where only a modification was expected;
 *   - a file that was deleted unexpectedly;
 *   - a file whose change is much larger than the rest of the change,
 *     measured in changed lines, which is the likely cause of the wide
 *     change;
 *   - a path that cannot be compared because it is not tracked, so that a
 *     reviewer knows the comparison was not complete.
 *
 * The checker uses nothing but the Node standard library, it runs the same
 * way on Linux, macOS and Windows, and it needs no installation step.
 *
 * Usage:
 *   node scripts/check-tree-scope.mjs [options]
 *
 * Options:
 *   --repo <dir>      The repository to check. Default: the repository the
 *                     script lives in.
 *   --base <ref>      The base to compare with. Default: the last commit.
 *                     The word index compares with the index instead, and
 *                     any other value is taken for the name of a ref.
 *   --expect <path>   A path the caller expects to change. May be given more
 *                     than once.
 *   --json            Print the findings as JSON instead of text.
 *   --quiet           Print the findings but not the closing summary.
 *   --self-test       Check the checker against throwaway repositories.
 *   --help            Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one finding, or the self-test failed.
 *   2  the command line could not be understood.
 *
 * What the checker never does:
 *   - it never writes to the repository and never stages anything;
 *   - it never runs the command that made the change;
 *   - it never prints the contents of a file, only its name, its kind and
 *     the number of lines that changed.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The number of changed lines that makes a change worth calling wide.
const WIDE_CHANGE_LINES = 20;

// How many times larger than the rest of the change the widest change has to
// be before it is named as the likely cause.
const WIDE_CHANGE_RATIO = 4;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * Normalise a path the way the caller wrote it into the way the tree names
 * it, so that a path written with a leading dot or a leading separator is
 * still recognised.
 */
function normalisePath(path) {
  let value = toPosix(path.trim()).replace(/^\.\//, '');
  while (value.startsWith('/')) value = value.slice(1);
  return value;
}

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

/** Run a read-only git command and return its output, or null when it fails. */
function git(repo, args) {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** True when the base the caller named is one that can be read. */
function baseExists(repo, base) {
  if (base === 'index') return true;
  return git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) !== null;
}

/**
 * Read the status and the number of changed lines of every path that
 * changed. Both come from one call to git, because a call is slow and the
 * checker runs once for every case of its self-test.
 */
function readDiff(repo, base) {
  const args = ['diff', '--raw', '--numstat', '-z', '--no-renames'];
  if (base !== 'index') args.push(base);
  const output = git(repo, args);
  if (output === null) return null;

  const statuses = [];
  const counts = new Map();
  const parts = output.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record.length === 0) continue;

    if (record.startsWith(':')) {
      // A raw record: the modes, the hashes and the status, then the path.
      const path = parts[index + 1];
      index += 1;
      if (path === undefined) break;
      const fields = record.split(' ');
      statuses.push({ status: fields[fields.length - 1], path: normalisePath(path) });
      continue;
    }

    // A record of lines: the lines added, the lines removed, then the path.
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const added = Number.parseInt(fields[0], 10);
    const deleted = Number.parseInt(fields[1], 10);
    // A file that is not text carries a dash instead of a number of lines.
    const lines = (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
    counts.set(normalisePath(fields[2]), lines);
  }

  return { statuses, counts };
}

/** List the paths that are in the working tree but are not tracked at all. */
function listUntrackedPaths(repo) {
  const output = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (output === null) return [];
  return output
    .split('\0')
    .filter((part) => part.length > 0)
    .map((part) => normalisePath(part));
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** The kind of a change, read from the status git reports. */
function readKind(status) {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  return 'modified';
}

/**
 * Sort the changed paths into the ones the caller expected and the ones
 * that changed anyway, and report the ones that changed anyway.
 */
function checkChanges(changes, expected, findings) {
  for (const change of changes) {
    const isExpected = expected.has(change.path);
    change.expected = isExpected;

    if (isExpected && change.kind === 'added') {
      findings.push({
        kind: 'expected-but-added',
        path: change.path,
        changedLines: change.changedLines,
        expected: true,
        message:
          `the caller expected only a modification of ${change.path}, but the file was added ` +
          'instead of changed',
      });
      continue;
    }

    if (isExpected && change.kind === 'deleted') {
      findings.push({
        kind: 'expected-but-deleted',
        path: change.path,
        changedLines: change.changedLines,
        expected: true,
        message:
          `the caller expected only a modification of ${change.path}, but the file was deleted ` +
          'instead of changed',
      });
      continue;
    }

    if (isExpected) continue;

    const kind = change.kind === 'added' ? 'unexpected-added'
      : change.kind === 'deleted' ? 'unexpected-deleted'
        : 'unexpected-modified';
    const verb = change.kind === 'added' ? 'was added'
      : change.kind === 'deleted' ? 'was deleted'
        : 'was changed';
    findings.push({
      kind,
      path: change.path,
      changedLines: change.changedLines,
      expected: false,
      message: `the file ${verb} although the caller expected it to stay as it was`,
    });
  }
}

/**
 * Report the file whose change is much larger than the rest. A change that
 * is far wider than everything else around it is the likely cause of the
 * wide change, whatever it is called.
 */
function checkWideChange(changes, findings) {
  const counted = changes.filter((change) => change.changedLines > 0);
  if (counted.length < 2) return;

  let total = 0;
  let widest = counted[0];
  for (const change of counted) {
    total += change.changedLines;
    if (change.changedLines > widest.changedLines) widest = change;
  }
  const rest = total - widest.changedLines;
  if (rest < 1) return;
  if (widest.changedLines < WIDE_CHANGE_LINES) return;
  if (widest.changedLines < WIDE_CHANGE_RATIO * rest) return;

  findings.push({
    kind: 'likely-cause',
    path: widest.path,
    changedLines: widest.changedLines,
    expected: widest.expected,
    message:
      `the file changed by ${widest.changedLines} line(s) while the rest of the change is ` +
      `${rest} line(s), so it is the likely cause of the wide change`,
  });
}

/**
 * Report the paths that could not be compared. A file that is not tracked
 * has nothing to compare against, so the comparison was not complete and a
 * reviewer has to know that.
 */
function checkUntracked(paths, expected, findings) {
  for (const path of paths) {
    const isExpected = expected.has(path);
    findings.push({
      kind: 'untracked',
      path,
      changedLines: 0,
      expected: isExpected,
      message: isExpected
        ? 'the caller expects this path to change, but it is not tracked, so it could not be compared'
        : 'the path is not tracked, so it could not be compared with the base',
    });
  }
}

// ---------------------------------------------------------------------------
// Running the checker
// ---------------------------------------------------------------------------

/** Read every path that changed between the base and the working tree. */
function readChanges(repo, base) {
  const diff = readDiff(repo, base);
  if (diff === null) return null;

  const changes = diff.statuses.map((entry) => ({
    path: entry.path,
    kind: readKind(entry.status),
    changedLines: diff.counts.get(entry.path) ?? 0,
    expected: false,
  }));
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return changes;
}

/** Check a whole repository and return the findings. */
function checkRepository(repo, options) {
  const base = options.base;
  const changes = readChanges(repo, base);
  if (changes === null) {
    // The base may be a name that does not exist, and then the message has
    // to say so rather than that something went wrong.
    if (!baseExists(repo, base)) {
      return { error: `the base "${base}" cannot be read from the repository` };
    }
    return { error: `the changes against the base "${base}" cannot be read` };
  }

  const findings = [];
  checkChanges(changes, options.expected, findings);
  checkWideChange(changes, findings);
  checkUntracked(listUntrackedPaths(repo), options.expected, findings);

  return { findings, changes };
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/** The environment that keeps a throwaway repository free of the machine. */
function fixtureEnvironment(configPath) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_AUTHOR_NAME: 'REPLACE_ME',
    GIT_AUTHOR_EMAIL: 'REPLACE_ME@example.invalid',
    GIT_COMMITTER_NAME: 'REPLACE_ME',
    GIT_COMMITTER_EMAIL: 'REPLACE_ME@example.invalid',
    GIT_AUTHOR_DATE: '2024-01-01T00:00:00+00:00',
    GIT_COMMITTER_DATE: '2024-01-01T00:00:00+00:00',
  };
}

/** Run a git command in a throwaway repository. */
function fixtureGit(repo, args, env) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Write a file into a throwaway repository. */
function writeFixture(root, name, content) {
  const path = join(root, name);
  const folder = dirname(path);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Copy a file and make it writable again, so that git can replace it later. */
function copyFile(from, to) {
  copyFileSync(from, to);
  chmodSync(to, 0o644);
}

/**
 * Copy a directory tree. Every case of the self-test gets a copy of the same
 * repository, which is much faster than building a repository from nothing
 * for every case.
 */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}

/**
 * Build the repository the cases start from: one commit with three files in
 * it, so that a case can change one of them, add one, or remove one.
 */
function createFixtureBase() {
  const root = mkdtempSync(join(tmpdir(), 'check-tree-scope-self-test-'));
  const repo = join(root, 'repository');
  const config = join(root, 'gitconfig-empty');
  mkdirSync(repo, { recursive: true });
  writeFileSync(config, '', 'utf8');
  const env = fixtureEnvironment(config);
  fixtureGit(repo, ['init', '--quiet', '.'], env);
  fixtureGit(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'], env);
  writeFixture(repo, 'package-lock.json', '{}\n');
  writeFixture(repo, 'notes.txt', 'one\ntwo\nthree\n');
  writeFixture(repo, 'source.txt', 'alpha\nbeta\ngamma\n');
  fixtureGit(repo, ['add', '--all'], env);
  fixtureGit(repo, ['commit', '--quiet', '--message', 'base'], env);
  return { root, repo, env };
}

/** The cases of the self-test: each one builds a repository and looks for a finding. */
function selfTestCases() {
  return [
    {
      name: 'an unrelated file that changed anyway',
      must: 'the unexpected change must be reported',
      build(root) {
        writeFixture(root, 'notes.txt', 'one\ntwo\nthree\nfour\n');
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'unexpected-modified' && finding.path === 'notes.txt'),
    },
    {
      name: 'a file that was added',
      must: 'the added file must be reported',
      build(root, env) {
        writeFixture(root, 'extra.txt', 'new\n');
        fixtureGit(root, ['add', 'extra.txt'], env);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'unexpected-added' && finding.path === 'extra.txt'),
    },
    {
      name: 'a file that was deleted',
      must: 'the deleted file must be reported',
      build(root) {
        rmSync(join(root, 'source.txt'), { force: true });
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'unexpected-deleted' && finding.path === 'source.txt'),
    },
    {
      name: 'a file that was added where only a modification was expected',
      must: 'the added file must be reported even though it was expected',
      expected: ['new-lock.json'],
      build(root, env) {
        writeFixture(root, 'new-lock.json', '{"version":1}\n');
        fixtureGit(root, ['add', 'new-lock.json'], env);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'expected-but-added' && finding.path === 'new-lock.json'),
    },
    {
      name: 'a change that is much wider than the rest',
      must: 'the likely cause must be reported',
      build(root) {
        const lines = [];
        for (let index = 0; index < 40; index += 1) lines.push(`line ${index}`);
        writeFixture(root, 'source.txt', `${lines.join('\n')}\n`);
        writeFixture(root, 'notes.txt', 'one\ntwo\n');
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'likely-cause' && finding.path === 'source.txt'),
    },
    {
      name: 'a path that is not tracked',
      must: 'the path that cannot be compared must be reported',
      build(root) {
        writeFixture(root, 'scratch.txt', 'not tracked\n');
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'untracked' && finding.path === 'scratch.txt'),
    },
    {
      name: 'a clean change that only touches the expected file',
      must: 'nothing must be reported',
      build(root) {
        writeFixture(root, 'package-lock.json', '{"version":1}\n');
      },
      expect: (findings) => findings.length === 0,
    },
  ];
}

/** Run every case of the self-test and report the ones that fail. */
function runSelfTest() {
  const failures = [];
  const cases = selfTestCases();
  const base = createFixtureBase();

  try {
    for (const testCase of cases) {
      const root = join(base.root, 'case');
      if (!existsSync(base.repo)) {
        failures.push('the temporary repository was removed while the self-test was running');
        break;
      }
      rmSync(root, { recursive: true, force: true });
      copyTree(base.repo, root);
      try {
        testCase.build(root, base.env);
        const expected = new Set(testCase.expected ?? ['package-lock.json']);
        const result = checkRepository(root, { base: 'HEAD', expected });
        if (result.error) {
          failures.push(`${testCase.name}: ${result.error}`);
          continue;
        }
        if (!testCase.expect(result.findings)) {
          failures.push(`${testCase.name}: ${testCase.must}`);
        }
      } catch (error) {
        failures.push(`${testCase.name}: the repository could not be built (${error.message})`);
      }
    }
  } finally {
    rmSync(base.root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stdout.write('check-tree-scope self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`check-tree-scope self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'check-tree-scope — check that a command changed only what it was asked to change.',
      '',
      'Usage:',
      '  node scripts/check-tree-scope.mjs [options]',
      '',
      'Options:',
      '  --repo <dir>      The repository to check. Default: the repository the',
      '                    script lives in.',
      '  --base <ref>      The base to compare with. Default: the last commit.',
      '                    The word index compares with the index instead, and',
      '                    any other value is taken for the name of a ref.',
      '  --expect <path>   A path the caller expects to change. May be given',
      '                    more than once.',
      '  --json            Print the findings as JSON instead of text.',
      '  --quiet           Print the findings but not the closing summary.',
      '  --self-test       Check the checker against throwaway repositories.',
      '  --help            Print this help and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one finding, or the self-test failed.',
      '  2  the command line could not be understood.',
      '',
      'The checker reads the tree and the history. It never writes to the',
      'repository, never stages anything and never runs the command that made',
      'the change.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = {
    repo: null,
    base: 'HEAD',
    expected: [],
    json: false,
    quiet: false,
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--quiet' || argument === '-q') options.quiet = true;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--repo' || argument === '--base' || argument === '--expect') {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        process.stderr.write(`check-tree-scope: the option "${argument}" needs a value\n`);
        return null;
      }
      if (argument === '--repo') options.repo = value;
      else if (argument === '--base') options.base = value;
      else options.expected.push(value);
    } else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    else if (argument.startsWith('--base=')) options.base = argument.slice('--base='.length);
    else if (argument.startsWith('--expect=')) options.expected.push(argument.slice('--expect='.length));
    else {
      process.stderr.write(`check-tree-scope: the option "${argument}" is not known\n`);
      return null;
    }
  }

  return options;
}

/** Print the findings. */
function report(result, options) {
  const findings = result.findings;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        count: findings.length,
        findings,
        changes: result.changes,
      }, null, 2)}\n`,
    );
    return;
  }
  for (const finding of findings) {
    process.stdout.write(`${finding.path}: [${finding.kind}] ${finding.message}\n`);
  }
  if (!options.quiet) {
    const expected = result.changes.filter((change) => change.expected).length;
    process.stdout.write(
      `check-tree-scope: ${findings.length} finding(s), ${result.changes.length} path(s) changed, ` +
      `${expected} expected\n`,
    );
  }
}

/** Run the checker. */
function main(argv) {
  const options = parseArguments(argv);
  if (options === null) return 2;
  if (options.help) {
    printUsage();
    return 0;
  }
  if (options.selfTest) return runSelfTest();

  const repo = resolve(options.repo ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  if (!existsSync(repo)) {
    process.stderr.write(`check-tree-scope: the directory "${repo}" does not exist\n`);
    return 2;
  }

  const expected = new Set(options.expected.map((path) => normalisePath(path)));
  const result = checkRepository(repo, { base: options.base, expected });
  if (result.error) {
    process.stderr.write(`check-tree-scope: ${result.error}\n`);
    return 2;
  }

  report(result, options);
  return result.findings.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
