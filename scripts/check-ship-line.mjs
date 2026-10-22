#!/usr/bin/env node
/**
 * check-ship-line.mjs — find the branches that claim to be the ship line.
 *
 * Two long-lived branches can both carry a release workflow, both be deployed
 * to the same environment, and neither contain the other. Merging them raises
 * dozens of conflicting files, and nothing warns about it until the release
 * is needed. The branch that carries the release workflow may be the one that
 * is behind.
 *
 * This tool reads the branches of a repository and reports the ones that
 * target the ship line, the release workflow each of them carries, the pairs
 * that neither contain the other, and the branches that fell behind without
 * a release workflow, because the work on such a branch cannot be released.
 *
 * The tool uses nothing but the Node standard library, it runs the same way
 * on Linux, macOS and Windows, and it only reads: it never writes to the
 * repository, never fetches, never merges and never builds anything.
 *
 * Usage:
 *   node scripts/check-ship-line.mjs [options]
 *
 * Options:
 *   --repo <dir>        Check another repository. Default: the repository
 *                       this script lives in.
 *   --ship-line <name>  The branch that is the ship line. Default: main.
 *   --json              Print the report as JSON instead of text.
 *   --quiet             Print the findings but not the closing summary line.
 *   --self-test         Build a throwaway repository and prove the rules work.
 *   --help              Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one problem was found, or the self-test failed.
 *   2  the command line could not be understood, or the repository could
 *      not be read.
 *
 * How the branches are judged:
 *   - The ship line is the branch that is deployed. It is named by
 *     --ship-line, and it is looked for as a local branch first and as
 *     origin/<name> second.
 *   - A branch that is behind the ship line has history of its own that the
 *     ship line does not have. Such a branch is a line in its own right.
 *   - A branch that carries a release or deployment workflow can be
 *     deployed to the environment of the ship line. Such a branch that is
 *     behind the ship line claims the ship line.
 *   - Two branches that both claim the ship line and neither contains the
 *     other are two ship lines. The report says how far apart they are.
 *   - A branch that is behind the ship line and carries no release workflow
 *     has work that cannot be released.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  aheadBehind,
  changedPaths,
  createTemporaryRepository,
  isAncestor,
  localBranches,
  repositoryRoot,
  revParse,
  shortHash,
  treePaths,
} from './lib/git.mjs';

// The folders that hold the automation of a repository.
const WORKFLOW_DIRECTORIES = new Set(['workflows', 'ci', 'pipeline', 'pipelines']);

// The file endings an automation file can have.
const WORKFLOW_EXTENSIONS = new Set(['.yml', '.yaml', '.json']);

// The words that turn a workflow into a release or a deployment.
const RELEASE_WORDS = /release|deploy|publish|promote/i;

// ---------------------------------------------------------------------------
// Finding the release workflows of a branch
// ---------------------------------------------------------------------------

/** True when the path is an automation file inside an automation folder. */
function isWorkflowFile(path) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  if (!WORKFLOW_EXTENSIONS.has(name.slice(dot).toLowerCase())) return false;
  return parts.slice(0, -1).some((folder) => WORKFLOW_DIRECTORIES.has(folder.toLowerCase()));
}

/** True when the path is a workflow that releases or deploys something. */
function isReleaseWorkflow(path) {
  if (!isWorkflowFile(path)) return false;
  const name = path.split('/').pop();
  const dot = name.lastIndexOf('.');
  return RELEASE_WORDS.test(dot === -1 ? name : name.slice(0, dot));
}

/** The release and deployment workflows a branch carries, by path. */
function releaseWorkflows(repo, commit) {
  return treePaths(repo, commit).filter(isReleaseWorkflow).sort();
}

// ---------------------------------------------------------------------------
// Reading the branches
// ---------------------------------------------------------------------------

/** The commit of the ship line, or null when the ship line does not exist. */
function resolveShipLine(repo, name) {
  const local = revParse(repo, name);
  if (local !== null) return { name, ref: name, commit: local };

  const remote = revParse(repo, `origin/${name}`);
  if (remote !== null) return { name, ref: `origin/${name}`, commit: remote };

  return null;
}

/** Read every branch of the repository and judge it against the ship line. */
function readBranches(repo, shipLine) {
  const branches = [];

  for (const name of localBranches(repo)) {
    if (name === shipLine.name) continue;

    const commit = revParse(repo, name);
    if (commit === null) continue;

    const distance = aheadBehind(repo, shipLine.commit, commit);
    const workflows = releaseWorkflows(repo, commit);
    const containsShipLine = isAncestor(repo, shipLine.commit, commit);

    branches.push({
      name,
      commit,
      ahead: distance.ahead,
      behind: distance.behind,
      containsShipLine,
      releaseWorkflows: workflows,
      // A branch that has fallen behind the ship line and can still be
      // deployed claims the ship line.
      claimsShipLine: distance.behind > 0 && workflows.length > 0,
    });
  }

  return branches;
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/** Two branches that both claim the ship line and neither contains the other. */
function findCompetingBranches(repo, branches) {
  const claims = branches.filter((branch) => branch.claimsShipLine);
  const findings = [];

  for (let first = 0; first < claims.length; first += 1) {
    for (let second = first + 1; second < claims.length; second += 1) {
      const left = claims[first];
      const right = claims[second];
      if (isAncestor(repo, left.commit, right.commit)) continue;
      if (isAncestor(repo, right.commit, left.commit)) continue;

      const distance = aheadBehind(repo, left.commit, right.commit);
      const differing = changedPaths(repo, left.commit, right.commit).length;

      findings.push({
        kind: 'ship-line-competition',
        branches: [left.name, right.name],
        apart: { [left.name]: distance.behind, [right.name]: distance.ahead },
        differingFiles: differing,
        workflows: {
          [left.name]: left.releaseWorkflows,
          [right.name]: right.releaseWorkflows,
        },
      });
    }
  }

  return findings;
}

/** A branch that fell behind the ship line and cannot release anything. */
function findMissingWorkflows(branches) {
  const findings = [];

  for (const branch of branches) {
    if (branch.behind === 0) continue;
    if (branch.ahead === 0) continue;
    if (branch.releaseWorkflows.length > 0) continue;

    findings.push({
      kind: 'release-workflow-missing',
      branches: [branch.name],
      behind: branch.behind,
      ahead: branch.ahead,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Check the repository and return the whole report. */
function checkRepository(repo, options) {
  const shipLine = resolveShipLine(repo, options.shipLine);
  if (shipLine === null) {
    return { error: `the ship line "${options.shipLine}" does not exist in this repository` };
  }

  const branches = readBranches(repo, shipLine);
  const findings = [...findCompetingBranches(repo, branches), ...findMissingWorkflows(branches)];

  return {
    tool: 'check-ship-line',
    shipLine: {
      name: shipLine.name,
      ref: shipLine.ref,
      commit: shipLine.commit,
      releaseWorkflows: releaseWorkflows(repo, shipLine.commit),
    },
    branches,
    findings,
    count: findings.length,
  };
}

/** Print the report. */
function report(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `check-ship-line: the ship line is ${result.shipLine.name} (${shortHash(result.shipLine.commit)})\n`,
  );
  if (result.shipLine.releaseWorkflows.length > 0) {
    process.stdout.write(
      `check-ship-line: the ship line carries ${result.shipLine.releaseWorkflows.join(', ')}\n`,
    );
  } else {
    process.stdout.write('check-ship-line: the ship line carries no release or deployment workflow\n');
  }
  process.stdout.write(
    `check-ship-line: ${result.branches.length} branch(es) besides the ship line\n`,
  );

  for (const branch of result.branches) {
    const workflows =
      branch.releaseWorkflows.length > 0 ? branch.releaseWorkflows.join(', ') : 'none';
    process.stdout.write(
      `check-ship-line: ${branch.name}: ${branch.ahead} commit(s) ahead, ${branch.behind} commit(s) behind, `
        + `the ship line is ${branch.containsShipLine ? 'included' : 'not included'}, release workflow: ${workflows}\n`,
    );
  }

  for (const finding of result.findings) {
    if (finding.kind === 'ship-line-competition') {
      const [left, right] = finding.branches;
      process.stdout.write(
        `check-ship-line: [ship-line-competition] ${left} and ${right} both claim the ship line, `
          + `neither contains the other, they are ${finding.apart[left]} commit(s) apart in each direction `
          + `and they differ in ${finding.differingFiles} file(s)\n`,
      );
    } else {
      const [branch] = finding.branches;
      process.stdout.write(
        `check-ship-line: [release-workflow-missing] ${branch} is ${finding.behind} commit(s) behind the ship line `
          + `and carries no release or deployment workflow, so the work on it cannot be released\n`,
      );
    }
  }

  if (!options.quiet) {
    process.stdout.write(`check-ship-line: ${result.count} finding(s)\n`);
  }
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/**
 * Build a repository with the shapes the checker is meant to catch: two
 * branches that both claim the ship line, a branch that fell behind without
 * a release workflow, and a branch that is up to date with the ship line.
 */
function buildBrokenFixture() {
  const repo = createTemporaryRepository('check-ship-line-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');

  // A branch cut before the release workflow existed, and left behind.
  repo.git(['checkout', '--quiet', '-b', 'feature/stale']);
  repo.commit('stale.txt', 'stale\n', 'work on a branch that fell behind');

  // The ship line gains a release workflow.
  repo.git(['checkout', '--quiet', 'main']);
  repo.commit('.github/workflows/release.yml', 'name: release\n', 'the ship line gains a release workflow');

  // A line that can be deployed, cut from the ship line.
  repo.git(['checkout', '--quiet', '-b', 'release/one']);
  repo.commit('one.txt', 'one\n', 'work on the first release line');

  // The ship line moves on, so the first release line falls behind.
  repo.git(['checkout', '--quiet', 'main']);
  repo.commit('base.txt', 'base\n', 'the ship line moves on');

  // A second line that can be deployed, cut from the same point.
  repo.git(['checkout', '--quiet', '-b', 'release/two', 'HEAD~1']);
  repo.commit('two.txt', 'two\n', 'work on the second release line');

  // A branch that is up to date with the ship line.
  repo.git(['checkout', '--quiet', '-b', 'feature/one', 'main']);
  repo.commit('feature.txt', 'feature\n', 'ordinary work');

  repo.git(['checkout', '--quiet', 'main']);
  return repo;
}

/** Build a repository where nothing is wrong. */
function buildHealthyFixture() {
  const repo = createTemporaryRepository('check-ship-line-self-test-');
  repo.commit('README.md', '# Fixture\n', 'first commit');
  repo.commit('.github/workflows/release.yml', 'name: release\n', 'the ship line gains a release workflow');
  repo.git(['checkout', '--quiet', '-b', 'feature/one']);
  repo.commit('feature.txt', 'feature\n', 'ordinary work');
  repo.git(['checkout', '--quiet', 'main']);
  return repo;
}

/** Run the checker against every fixture and report the cases that fail. */
function runSelfTest() {
  const failures = [];
  const repositories = [];

  const cases = [
    {
      name: 'two branches that both claim the ship line',
      build: buildBrokenFixture,
      check(result) {
        const competition = result.findings.find((finding) => finding.kind === 'ship-line-competition');
        if (!competition) return 'the two branches that claim the ship line were not reported';
        if (!competition.branches.includes('release/one')) return 'the first release line was not named';
        if (!competition.branches.includes('release/two')) return 'the second release line was not named';
        if (competition.differingFiles < 1) return 'the distance between the branches was not reported';
        return null;
      },
    },
    {
      name: 'a branch behind the ship line without a release workflow',
      build: buildBrokenFixture,
      check(result) {
        const missing = result.findings.find((finding) => finding.kind === 'release-workflow-missing');
        if (!missing) return 'the branch without a release workflow was not reported';
        if (!missing.branches.includes('feature/stale')) return 'the branch that fell behind was not named';
        return null;
      },
    },
    {
      name: 'a branch that is up to date with the ship line',
      build: buildBrokenFixture,
      check(result) {
        const reported = result.findings.some((finding) => finding.branches.includes('feature/one'));
        if (reported) return 'a branch that is up to date with the ship line was reported';
        return null;
      },
    },
    {
      name: 'a repository where nothing is wrong',
      build: buildHealthyFixture,
      check(result) {
        if (result.findings.length > 0) return 'a healthy repository was reported';
        return null;
      },
    },
  ];

  // A fixture is built once, even when more than one case looks at it.
  const built = new Map();

  for (const testCase of cases) {
    let repo = built.get(testCase.build);
    try {
      if (repo === undefined) {
        repo = testCase.build();
        built.set(testCase.build, repo);
        repositories.push(repo);
      }

      const result = checkRepository(repo.root, { shipLine: 'main' });
      if (result.error) {
        failures.push(`${testCase.name}: ${result.error}`);
        continue;
      }
      const problem = testCase.check(result);
      if (problem) failures.push(`${testCase.name}: ${problem}`);
    } catch (error) {
      failures.push(`${testCase.name}: the case could not be run (${error.message})`);
    }
  }

  // The throwaway repositories are removed even when a case fails, so that a
  // broken self-test does not leave anything behind.
  for (const repo of repositories) repo.remove();

  if (failures.length > 0) {
    process.stdout.write('check-ship-line self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`check-ship-line self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'check-ship-line — find the branches that claim to be the ship line.',
      '',
      'Usage:',
      '  node scripts/check-ship-line.mjs [options]',
      '',
      'Options:',
      '  --repo <dir>        Check another repository. Default: the repository',
      '                      this script lives in.',
      '  --ship-line <name>  The branch that is the ship line. Default: main.',
      '  --json              Print the report as JSON instead of text.',
      '  --quiet             Print the findings but not the closing summary line.',
      '  --self-test         Build a throwaway repository and prove the rules',
      '                      work.',
      '  --help              Print this help and exit.',
      '',
      'How the branches are judged:',
      '  The ship line is the branch that is deployed. A branch that is behind',
      '  it has history of its own that the ship line does not have. A branch',
      '  that carries a release or deployment workflow can be deployed to the',
      '  environment of the ship line, and such a branch that is behind the',
      '  ship line claims the ship line.',
      '',
      '  Two branches that both claim the ship line and neither contains the',
      '  other are two ship lines. The report says how far apart they are in',
      '  commits and how many files they differ in.',
      '',
      '  A branch that is behind the ship line and carries no release workflow',
      '  has work that cannot be released.',
      '',
      '  Only names, kinds and counts are printed. No file is ever read and',
      '  no file is ever printed. The tool only reads: it never writes to the',
      '  repository, never fetches, never merges and never builds anything.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one problem was found, or the self-test failed.',
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
    shipLine: 'main',
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
    else if (argument === '--ship-line') {
      index += 1;
      options.shipLine = argv[index];
    } else if (argument.startsWith('--ship-line=')) options.shipLine = argument.slice('--ship-line='.length);
    else {
      process.stderr.write(`check-ship-line: the option "${argument}" is not known\n`);
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
    process.stderr.write('check-ship-line: the directory does not exist\n');
    return 2;
  }

  const repository = repositoryRoot(root);
  if (repository === null) {
    process.stderr.write('check-ship-line: this directory is not inside a git repository\n');
    return 2;
  }
  if (revParse(repository, 'HEAD') === null) {
    process.stderr.write('check-ship-line: the repository has no commit yet, so there is nothing to check\n');
    return 2;
  }

  const result = checkRepository(repository, options);
  if (result.error) {
    process.stderr.write(`check-ship-line: ${result.error}\n`);
    return 2;
  }

  report(result, options);
  return result.count > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
