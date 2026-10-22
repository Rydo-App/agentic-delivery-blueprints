#!/usr/bin/env node
/**
 * merge-check.mjs — prove that a merge has not dropped a file the base had.
 *
 * A merge can carry the right merge head, report one conflicting file, and
 * still have dropped the files that only the base had. The files that were
 * dropped are the base's additions, so the tree that comes out compiles and
 * passes its tests: the loss is invisible in the diff, because the missing
 * files are simply not there.
 *
 * The only way to see it is to compare the index with the base tree, file by
 * file, before the merge is committed. This tool does exactly that. It reads
 * the index, which is what the next commit would record, and it reads the
 * base tree. It never reads the working tree, because the working tree is
 * not what gets committed.
 *
 * The tool uses nothing but the Node standard library, it runs the same way
 * on Linux, macOS and Windows, and it never writes to the repository: it
 * does not change the index, does not check anything out, does not stash,
 * does not merge and does not fetch.
 *
 * Usage:
 *   node scripts/merge-check.mjs [options]
 *
 * Options:
 *   --repo <dir>   Check another repository. Default: the repository this
 *                  script lives in.
 *   --base <ref>   The base line to compare the index with. Default:
 *                  origin/main, then main, then master.
 *   --json         Print the report as JSON instead of text.
 *   --quiet        Print the findings but not the closing summary line.
 *   --self-test    Build a throwaway repository and prove the rules work.
 *   --help         Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was lost, or the self-test passed.
 *   1  at least one path was lost, or the self-test failed.
 *   2  the command line could not be understood, or the repository could
 *      not be read.
 *
 * What is compared, and what the report says:
 *   - The index is compared with the base tree, never with the working
 *     tree. A path that the base tree has and the index does not have is a
 *     path that the merge result would be missing.
 *   - Every such path is reported with the kind of change the base made to
 *     it: added, modified, renamed, or unchanged, which means both sides
 *     had it and the merge dropped it.
 *   - A path that the base deleted and the index also does not have is a
 *     deletion that both sides agreed on. It is reported as correct, because
 *     it is not a loss.
 *   - A path that the branch had already dropped before the merge started
 *     is reported as a branch removal. The merge did not cause it, so it
 *     is a different finding and it is named differently.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  createTemporaryRepository,
  currentBranch,
  diffKinds,
  indexPaths,
  isAncestor,
  mergeBase,
  repositoryRoot,
  revParse,
  shortHash,
  treePaths,
  tryGit,
} from './lib/git.mjs';

// The base lines that are tried when the command line does not name one.
const DEFAULT_BASE_REFS = [
  { ref: 'origin/main', name: 'refs/remotes/origin/main' },
  { ref: 'main', name: 'refs/heads/main' },
  { ref: 'master', name: 'refs/heads/master' },
];

// ---------------------------------------------------------------------------
// Working out which side is the base
// ---------------------------------------------------------------------------

/**
 * Find the side of the comparison that is the base. When a merge is in
 * progress there are two sides: HEAD and MERGE_HEAD. The base is the line
 * the change is going into, and the branch is the line that carries the
 * change.
 */
function resolveSides(repo, baseOption) {
  const ours = revParse(repo, 'HEAD');
  const theirs = revParse(repo, 'MERGE_HEAD');
  const baseRef = baseOption ?? findDefaultBaseRef(repo);
  const baseCommit = baseRef ? revParse(repo, baseRef) : null;

  let baseSide = 'ref';
  let branchSide = 'ours';

  if (theirs === null) {
    // Without a merge in progress the index is compared with the base line
    // and the branch side is the current commit.
    baseSide = 'ref';
    branchSide = 'ours';
  } else if (baseCommit === ours) {
    baseSide = 'ours';
    branchSide = 'theirs';
  } else if (baseCommit === theirs) {
    baseSide = 'theirs';
    branchSide = 'ours';
  } else if (baseCommit && isAncestor(repo, baseCommit, ours) && !isAncestor(repo, baseCommit, theirs)) {
    baseSide = 'ours';
    branchSide = 'theirs';
  } else if (baseCommit && isAncestor(repo, baseCommit, theirs) && !isAncestor(repo, baseCommit, ours)) {
    baseSide = 'theirs';
    branchSide = 'ours';
  } else if (baseOption) {
    // The base was named on the command line and it is not part of the
    // merge, so the tree that was named is the tree to compare with.
    baseSide = 'ref';
    branchSide = 'theirs';
  } else {
    // The merge lands on HEAD, so HEAD is the line the change goes into.
    baseSide = 'ours';
    branchSide = 'theirs';
  }

  const baseTreeCommit = baseSide === 'ours' ? ours : baseSide === 'theirs' ? theirs : baseCommit ?? ours;
  const branchCommit = branchSide === 'ours' ? ours : theirs;

  // The names that the report uses for the two sides. The base is named by
  // the ref when the ref is the side, so that the report says "main" rather
  // than saying "MERGE_HEAD".
  const branch = currentBranch(repo);
  const headName = branch === null ? 'HEAD' : branch;
  let baseName = baseRef ?? 'the base';
  if (baseSide === 'ours') baseName = headName;
  else if (baseSide === 'theirs') baseName = baseCommit === theirs ? (baseRef ?? 'MERGE_HEAD') : 'MERGE_HEAD';
  const branchName = branchSide === 'ours' ? headName : 'MERGE_HEAD';

  return {
    baseRef: baseCommit ? baseRef : 'HEAD',
    baseCommit: baseTreeCommit,
    baseSide,
    baseName,
    branchCommit,
    branchSide,
    branchName,
    mergeBase: mergeBase(repo, baseTreeCommit, branchCommit),
    mergeInProgress: theirs !== null,
  };
}

/** The first base line of the default list that the repository knows. */
function findDefaultBaseRef(repo) {
  // The names are asked for in one command, so that a repository that has
  // none of them does not cost three round trips.
  const output = tryGit(repo, [
    'for-each-ref',
    '--format=%(refname)',
    ...DEFAULT_BASE_REFS.map((entry) => entry.name),
  ]);
  if (output === null) return null;

  const present = new Set(
    output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
  );
  for (const entry of DEFAULT_BASE_REFS) {
    if (present.has(entry.name)) return entry.ref;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparing the index with the base tree
// ---------------------------------------------------------------------------

/**
 * Compare the index with the base tree and report the paths that the base
 * had and the index no longer has.
 */
function compareIndexWithBase(repo, sides) {
  const basePaths = new Set(treePaths(repo, sides.baseCommit));
  const index = new Set(indexPaths(repo));

  // The kinds of change are read against the merge base, so a path that the
  // base added after the branch was cut is told apart from a path that the
  // base had for a long time.
  const baseKinds = sides.mergeBase
    ? diffKinds(repo, sides.mergeBase, sides.baseCommit)
    : new Map();
  const branchKinds = sides.mergeBase
    ? diffKinds(repo, sides.mergeBase, sides.branchCommit)
    : new Map();

  const findings = [];
  const agreed = [];
  const stale = [];

  // A path the base removed is a path the index should not have either.
  // When the index does not have it, both sides agreed on the removal and
  // the result is correct.
  for (const [path, entry] of baseKinds) {
    if (entry.kind !== 'deleted' && entry.kind !== 'renamed-away') continue;
    if (index.has(path)) stale.push(path);
    else agreed.push(path);
  }

  // Every path the base has and the index does not have.
  for (const path of [...basePaths].sort()) {
    if (index.has(path)) continue;

    const baseEntry = baseKinds.get(path);
    const baseChange = baseEntry ? baseEntry.kind : 'unchanged';
    const baseSource = baseEntry && baseEntry.source ? baseEntry.source : null;
    const branchEntry = branchKinds.get(path);
    const branchChange = branchEntry ? branchEntry.kind : 'unchanged';

    if (branchChange === 'deleted' || branchChange === 'renamed-away') {
      // The branch dropped the path before the merge started, so the merge
      // is not the reason it is missing.
      findings.push({ kind: 'branch-removal', path, baseChange, baseSource, branchChange });
    } else {
      findings.push({ kind: 'merge-loss', path, baseChange, baseSource });
    }
  }

  return {
    findings,
    agreed: agreed.sort(),
    stale: stale.sort(),
    basePathCount: basePaths.size,
    indexPathCount: index.size,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** A sentence that says what the base did to a path. */
function describeBaseChange(finding) {
  if (finding.baseChange === 'added') return 'the base added it';
  if (finding.baseChange === 'modified') return 'the base changed it';
  if (finding.baseChange === 'renamed') return `the base renamed it from ${finding.baseSource}`;
  if (finding.baseChange === 'type-changed') return 'the base changed what it is';
  return 'both sides had it';
}

/** Check the repository and return the whole report. */
function checkRepository(repo, options) {
  const sides = resolveSides(repo, options.base);
  const comparison = compareIndexWithBase(repo, sides);

  return {
    tool: 'merge-check',
    mergeInProgress: sides.mergeInProgress,
    base: {
      ref: sides.baseRef,
      commit: sides.baseCommit,
      side: sides.baseSide,
      name: sides.baseName,
    },
    branch: {
      commit: sides.branchCommit,
      side: sides.branchSide,
      name: sides.branchName,
    },
    mergeBase: sides.mergeBase,
    counts: {
      baseTree: comparison.basePathCount,
      index: comparison.indexPathCount,
    },
    findings: comparison.findings,
    agreedPaths: comparison.agreed,
    stalePaths: comparison.stale,
    count: comparison.findings.length,
  };
}

/** Print the report. */
function report(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write('merge-check: comparing the index with the base tree\n');
  process.stdout.write(
    result.mergeInProgress
      ? 'merge-check: a merge is in progress\n'
      : 'merge-check: no merge is in progress\n',
  );
  process.stdout.write(
    `merge-check: base side: ${result.base.name} (${shortHash(result.base.commit)})\n`,
  );
  process.stdout.write(
    `merge-check: branch side: ${result.branch.name} (${shortHash(result.branch.commit)})\n`,
  );
  if (result.mergeBase) {
    process.stdout.write(`merge-check: merge base: ${shortHash(result.mergeBase)}\n`);
  } else {
    process.stdout.write('merge-check: merge base: none, the two sides have no common ancestor\n');
  }
  process.stdout.write(
    `merge-check: the base tree holds ${result.counts.baseTree} path(s), the index holds ${result.counts.index} path(s)\n`,
  );
  process.stdout.write(
    `merge-check: the base removed ${result.agreedPaths.length} path(s) that the index does not have either, which both sides agreed on\n`,
  );
  if (result.stalePaths.length > 0) {
    process.stdout.write(
      `merge-check: ${result.stalePaths.length} path(s) the base removed are still in the index\n`,
    );
  }

  for (const finding of result.findings) {
    if (finding.kind === 'merge-loss') {
      process.stdout.write(
        `merge-check: [merge-loss] ${finding.path}: ${describeBaseChange(finding)}, the index does not have it\n`,
      );
    } else {
      process.stdout.write(
        `merge-check: [branch-removal] ${finding.path}: the branch removed it before the merge, the base still has it\n`,
      );
    }
  }

  if (!options.quiet) {
    process.stdout.write(`merge-check: ${result.count} finding(s)\n`);
  }
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/**
 * Build a repository that is ready to be merged: the branch carries work of
 * its own, and the base has gained a file since the branch was cut.
 */
function buildMergeFixture() {
  const repo = createTemporaryRepository('merge-check-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');
  repo.commit('kept.txt', 'kept\n', 'first commit');
  repo.git(['checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feature\n', 'work on the branch');
  repo.git(['checkout', '--quiet', 'main']);
  repo.commit('base-only.txt', 'base only\n', 'work on the base');
  repo.git(['checkout', '--quiet', 'feature']);
  return repo;
}

/** Build a repository where the merge dropped a file only the base had. */
function buildDroppedFileFixture() {
  const repo = buildMergeFixture();
  // A merge that takes one side as the whole result drops the files that
  // only the other side had. Nothing is reported as a conflict.
  repo.git(['merge', '--no-commit', '--no-ff', '-s', 'ours', 'main']);
  return repo;
}

/** Build a repository where the merge kept everything both sides had. */
function buildCleanMergeFixture() {
  const repo = buildMergeFixture();
  repo.git(['merge', '--no-commit', '--no-ff', 'main']);
  return repo;
}

/** Build a repository where the branch dropped a file before the merge. */
function buildBranchRemovalFixture() {
  const repo = createTemporaryRepository('merge-check-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');
  repo.commit('doomed.txt', 'doomed\n', 'first commit');
  repo.git(['checkout', '--quiet', '-b', 'feature']);
  repo.git(['rm', '--quiet', 'doomed.txt']);
  repo.commit(null, null, 'the branch removed a file');
  repo.git(['checkout', '--quiet', 'main']);
  repo.commit('README.md', '# Fixture, changed on the base\n', 'work on the base');
  repo.git(['checkout', '--quiet', 'feature']);
  repo.git(['merge', '--no-commit', '--no-ff', 'main']);
  return repo;
}

/** Build a repository where the base removed a file and the merge agreed. */
function buildAgreedDeletionFixture() {
  const repo = createTemporaryRepository('merge-check-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');
  repo.commit('old.txt', 'old\n', 'first commit');
  repo.git(['checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feature\n', 'work on the branch');
  repo.git(['checkout', '--quiet', 'main']);
  repo.git(['rm', '--quiet', 'old.txt']);
  repo.commit(null, null, 'the base removed a file');
  repo.git(['checkout', '--quiet', 'feature']);
  repo.git(['merge', '--no-commit', '--no-ff', 'main']);
  return repo;
}

/** Build a repository that has no merge in progress. */
function buildPlainFixture() {
  const repo = createTemporaryRepository('merge-check-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');
  return repo;
}

/** Run the checker against every fixture and report the cases that fail. */
function runSelfTest() {
  const failures = [];

  const cases = [
    {
      name: 'a merge that dropped a file the base had',
      build: buildDroppedFileFixture,
      check(result) {
        const loss = result.findings.find(
          (finding) => finding.kind === 'merge-loss' && finding.path === 'base-only.txt',
        );
        if (!loss) return 'the dropped file was not reported as a loss';
        if (loss.baseChange !== 'added') return 'the loss was not reported as an addition of the base';
        return null;
      },
    },
    {
      name: 'a clean merge',
      build: buildCleanMergeFixture,
      check(result) {
        if (result.findings.length > 0) return 'the clean merge was reported as a loss';
        if (!result.mergeInProgress) return 'the merge in progress was not found';
        return null;
      },
    },
    {
      name: 'a file the branch removed before the merge',
      build: buildBranchRemovalFixture,
      check(result) {
        const removal = result.findings.find(
          (finding) => finding.kind === 'branch-removal' && finding.path === 'doomed.txt',
        );
        if (!removal) return 'the removal by the branch was not reported';
        if (result.findings.some((finding) => finding.kind === 'merge-loss')) {
          return 'the removal by the branch was reported as a loss of the merge';
        }
        return null;
      },
    },
    {
      name: 'a file the base removed and the merge agreed on',
      build: buildAgreedDeletionFixture,
      check(result) {
        if (result.findings.length > 0) return 'a deletion both sides agreed on was reported as a loss';
        if (!result.agreedPaths.includes('old.txt')) return 'the agreed deletion was not reported as agreed';
        return null;
      },
    },
    {
      name: 'a repository without a merge in progress',
      build: buildPlainFixture,
      check(result) {
        if (result.mergeInProgress) return 'a merge was reported where there is none';
        if (result.findings.length > 0) return 'the repository was reported as a loss';
        return null;
      },
    },
  ];

  for (const testCase of cases) {
    let repo = null;
    try {
      repo = testCase.build();
      const result = checkRepository(repo.root, { base: null });
      const problem = testCase.check(result);
      if (problem) failures.push(`${testCase.name}: ${problem}`);
    } catch (error) {
      failures.push(`${testCase.name}: the case could not be run (${error.message})`);
    } finally {
      // The throwaway repository is removed even when the case fails, so
      // that a broken self-test does not leave anything behind.
      if (repo !== null) repo.remove();
    }
  }

  if (failures.length > 0) {
    process.stdout.write('merge-check self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`merge-check self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'merge-check — prove that a merge has not dropped a file the base had.',
      '',
      'Usage:',
      '  node scripts/merge-check.mjs [options]',
      '',
      'Options:',
      '  --repo <dir>   Check another repository. Default: the repository this',
      '                 script lives in.',
      '  --base <ref>   The base line to compare the index with. Default:',
      '                 origin/main, then main, then master.',
      '  --json         Print the report as JSON instead of text.',
      '  --quiet        Print the findings but not the closing summary line.',
      '  --self-test    Build a throwaway repository and prove the rules work.',
      '  --help         Print this help and exit.',
      '',
      'What is compared:',
      '  The index, which is what the next commit would record, against the',
      '  base tree, which is the tree of the base side of the merge. The',
      '  working tree is never read, because the working tree is not what',
      '  gets committed. Every path is reported relative to the root of the',
      '  repository, and no file is ever printed.',
      '',
      '  A path that the base tree has and the index does not have is a path',
      '  the merge result would be missing. It is reported with the kind of',
      '  change the base made to it: added, modified, renamed or unchanged.',
      '',
      '  A path that the base deleted and the index also does not have is a',
      '  deletion both sides agreed on. It is reported as correct, because a',
      '  deletion that was agreed on is not a loss.',
      '',
      '  A path that the branch had already dropped before the merge started',
      '  is reported as a branch removal and not as a loss of the merge.',
      '',
      '  The tool reads only. It never writes to the repository, never',
      '  changes the index, never checks anything out, never stashes, never',
      '  merges and never fetches.',
      '',
      'Exit codes:',
      '  0  nothing was lost, or the self-test passed.',
      '  1  at least one path was lost, or the self-test failed.',
      '  2  the command line could not be understood, or the repository could',
      '     not be read.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = {
    repo: null,
    base: null,
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
    else if (argument === '--repo' || argument === '--dir') {
      index += 1;
      options.repo = argv[index];
    } else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    else if (argument === '--base') {
      index += 1;
      options.base = argv[index];
    } else if (argument.startsWith('--base=')) options.base = argument.slice('--base='.length);
    else {
      process.stderr.write(`merge-check: the option "${argument}" is not known\n`);
      return null;
    }
  }

  return options;
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

  const root = resolve(options.repo ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  if (!existsSync(root)) {
    process.stderr.write('merge-check: the directory does not exist\n');
    return 2;
  }

  const repository = repositoryRoot(root);
  if (repository === null) {
    process.stderr.write('merge-check: this directory is not inside a git repository\n');
    return 2;
  }
  if (revParse(repository, 'HEAD') === null) {
    process.stderr.write('merge-check: the repository has no commit yet, so there is nothing to compare\n');
    return 2;
  }
  if (options.base && revParse(repository, options.base) === null) {
    process.stderr.write(`merge-check: the base "${options.base}" does not exist in this repository\n`);
    return 2;
  }

  const result = checkRepository(repository, options);
  report(result, options);
  return result.count > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
