#!/usr/bin/env node
/**
 * check-migrations.mjs — a migration number checker for a repository.
 *
 * Two branches that number their migrations from the same beginning produce
 * two different migrations with one number. The runner keys on the whole file
 * name, so nothing detects the collision: both files run, and the order
 * between them is the order of the file names rather than the order of the
 * numbers. A reader of the history believes they were sequenced by their
 * numbers.
 *
 * The checker reads the migration files of every branch of a repository and
 * reports:
 *
 *   - a number that is used by more than one migration, naming the files and
 *     the branches that carry it;
 *   - a number that is used by two files in the same branch, which is a
 *     different and more urgent defect than a collision between two branches;
 *   - a gap in the numbering of a branch;
 *   - a number that has an up file but no down file, or the other way round;
 *   - a migration whose number is not the lowest of the numbers that follow
 *     it in the same branch, which is the sign that the numbers no longer say
 *     what order the migrations run in.
 *
 * The checker uses nothing but the Node standard library, it runs the same
 * way on Linux, macOS and Windows, and it needs no installation step.
 *
 * Usage:
 *   node scripts/check-migrations.mjs [options]
 *
 * Options:
 *   --repo <dir>          The repository to check. Default: the repository
 *                         the script lives in.
 *   --dir <path>          The directory that holds the migrations.
 *                         Default: migrations.
 *   --pattern <glob>      The pattern that matches a migration file.
 *                         Default: *_*.up.sql.
 *   --down-pattern <glob> The pattern that matches a rollback file. Default:
 *                         the pattern above with up replaced by down.
 *   --branches <a,b,c>    The branches to read. Default: the local branches.
 *   --json                Print the findings as JSON instead of text.
 *   --quiet               Print the findings but not the closing summary.
 *   --self-test           Check the checker against throwaway repositories.
 *   --help                Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one finding, or the self-test failed.
 *   2  the command line could not be understood.
 *
 * What the checker never does:
 *   - it never touches a database and never runs a migration;
 *   - it never writes to the repository and never changes the index;
 *   - it never prints the contents of a migration, only its name, its number
 *     and where it sits.
 *
 * The layout of the migrations is a setting rather than a constant, because
 * projects lay their migrations out differently. The pattern is matched
 * against the name of the file and against its path under the directory of
 * the migrations, and a star in the pattern does not cross a directory
 * separator.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The directory that holds the migrations, when the caller does not say.
const DEFAULT_DIRECTORY = 'migrations';

// The pattern that matches a migration file, when the caller does not say.
// The pattern is a setting because every project names its migrations its own
// way, and a checker that insists on one name is a checker that is switched
// off in the first repository it meets.
const DEFAULT_PATTERN = '*_*.up.sql';

// The name given to the working tree when the repository has no branches, so
// that a directory of migrations can still be checked without a history.
const WORKING_TREE_BRANCH = 'worktree';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/** Escape the characters that have a meaning in a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn a glob into a regular expression. A star matches inside one segment,
 * two stars match across segments, a question mark matches one character and
 * a bracket holds a set of characters.
 */
function globToRegExp(pattern) {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2;
        if (pattern[index] === '/') {
          index += 1;
          source += '(?:[^/]*/)*';
        } else {
          source += '.*';
        }
      } else {
        index += 1;
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close !== -1) {
        let body = pattern.slice(index + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body}]`;
        index = close + 1;
        continue;
      }
    }
    source += escapeRegExp(character);
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

/**
 * The pattern of the rollback file that goes with a pattern of migration
 * files. The direction is part of the name of the file, so the rollback
 * pattern is the migration pattern with the direction changed.
 */
function deriveDownPattern(pattern) {
  if (pattern.endsWith('.up.sql')) return `${pattern.slice(0, -'.up.sql'.length)}.down.sql`;
  const marker = pattern.lastIndexOf('.up');
  if (marker !== -1) return `${pattern.slice(0, marker)}.down${pattern.slice(marker + 3)}`;
  return `${pattern.replace(/\.sql$/, '')}.down.sql`;
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

/** List the local branches of a repository. */
function listLocalBranches(repo) {
  const output = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (output === null) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** List the files of a directory in one commit of the repository. */
function listFilesInTree(repo, ref, directory) {
  const output = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', directory]);
  if (output === null) return null;
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** List every file under a directory of the working tree. */
function listFilesInDirectory(root, directory) {
  const files = [];
  const queue = [resolve(root, directory)];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(toPosix(relative(root, full)));
    }
  }
  return files.sort();
}

/** The path of a file under the directory of the migrations. */
function pathUnderDirectory(filePath, directory) {
  const normalised = toPosix(directory).replace(/\/+$/, '');
  if (normalised === '' || normalised === '.') return filePath;
  const prefix = `${normalised}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

/**
 * Read the number and the name out of a migration file name. A file that
 * does not start with a number is not a numbered migration and is reported
 * separately, because a number is the whole point of the check.
 */
function readMigrationName(fileName) {
  const match = /^(\d+)[_.-]?(.*)$/.exec(fileName);
  if (!match) return null;
  const stem = fileName.replace(/\.(up|down)(\.[^.]+)?$/, '');
  return {
    number: Number(match[1]),
    numberText: match[1],
    stem,
    name: stem.replace(/^\d+[_.-]?/, ''),
  };
}

/**
 * Read the migration files of one branch. A file is a migration when the
 * pattern matches its name or the path it has under the directory of the
 * migrations.
 */
function readBranchMigrations(repo, branch, options) {
  const upPattern = globToRegExp(options.pattern);
  const downPattern = globToRegExp(options.downPattern);
  const files = [];
  const unnumbered = [];

  for (const filePath of branch.files) {
    const fileName = basename(filePath);
    const underDirectory = pathUnderDirectory(filePath, options.directory);
    const isUp = upPattern.test(fileName) || upPattern.test(underDirectory);
    const isDown = downPattern.test(fileName) || downPattern.test(underDirectory);
    if (!isUp && !isDown) continue;

    const identity = readMigrationName(fileName);
    if (identity === null) {
      unnumbered.push({ path: filePath, branch: branch.name });
      continue;
    }
    files.push({
      path: filePath,
      branch: branch.name,
      direction: isUp ? 'up' : 'down',
      number: identity.number,
      numberText: identity.numberText,
      stem: identity.stem,
      name: identity.name,
    });
  }

  return { ...branch, files, unnumbered };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Group the migration files of a branch by their number. */
function groupByNumber(files) {
  const groups = new Map();
  for (const file of files) {
    const list = groups.get(file.number) ?? [];
    list.push(file);
    groups.set(file.number, list);
  }
  return groups;
}

/** Sort the migration files the way the runner applies them, by file name. */
function sortByFileName(files) {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Check one branch. The rules are the ones the branch has to satisfy on its
 * own: a number that is used twice, a number that has no partner, a gap in
 * the sequence and a sequence that does not ascend in the order the runner
 * applies the files.
 */
function checkBranch(branch, findings) {
  const groups = groupByNumber(branch.files);
  const numbers = [...groups.keys()].sort((left, right) => left - right);

  for (const number of numbers) {
    const files = groups.get(number);
    const up = files.filter((file) => file.direction === 'up');
    const down = files.filter((file) => file.direction === 'down');

    // Two migrations with one number in one branch. This is more urgent than
    // a collision between two branches, because both files are in the same
    // history and the branch cannot be applied cleanly.
    if (up.length > 1 || down.length > 1) {
      const duplicated = up.length > 1 ? up : down;
      findings.push({
        kind: 'duplicate-in-branch',
        path: duplicated[0].path,
        branch: branch.name,
        number,
        numberText: duplicated[0].numberText,
        message:
          `the number ${number} is used by ${duplicated.length} ${duplicated[0].direction} file(s) ` +
          `in the branch "${branch.name}": ${duplicated.map((file) => file.path).join(', ')}`,
      });
    }

    // A migration without a partner in the other direction.
    if (up.length > 0 && down.length === 0) {
      findings.push({
        kind: 'missing-down',
        path: up[0].path,
        branch: branch.name,
        number,
        numberText: up[0].numberText,
        message: `the number ${number} has an up file but no down file in the branch "${branch.name}"`,
      });
    }
    if (down.length > 0 && up.length === 0) {
      findings.push({
        kind: 'missing-up',
        path: down[0].path,
        branch: branch.name,
        number,
        numberText: down[0].numberText,
        message: `the number ${number} has a down file but no up file in the branch "${branch.name}"`,
      });
    }

    // A pair whose two halves do not carry the same name.
    if (up.length === 1 && down.length === 1 && up[0].stem !== down[0].stem) {
      findings.push({
        kind: 'name-mismatch',
        path: up[0].path,
        branch: branch.name,
        number,
        numberText: up[0].numberText,
        message:
          `the number ${number} has an up file and a down file that do not carry the same name ` +
          `in the branch "${branch.name}": ${up[0].path} and ${down[0].path}`,
      });
    }
  }

  // A gap in the sequence. The first number of a branch is left alone,
  // because a project may start its sequence wherever it likes.
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (current <= previous + 1) continue;
    findings.push({
      kind: 'gap',
      path: groups.get(current)[0].path,
      branch: branch.name,
      number: previous + 1,
      message:
        `the branch "${branch.name}" skips the numbers ${previous + 1} to ${current - 1} ` +
        `between ${previous} and ${current}`,
    });
  }

  // A number that is not the lowest of the numbers that follow it. The runner
  // applies the files in the order of their names, so a sequence that does
  // not ascend in that order means the numbers no longer say what order the
  // migrations run in.
  const ordered = sortByFileName(branch.files.filter((file) => file.direction === 'up'));
  for (let index = 0; index < ordered.length; index += 1) {
    const file = ordered[index];
    const following = ordered.slice(index + 1).map((item) => item.number);
    if (following.length === 0) continue;
    const lowest = Math.min(...following);
    if (file.number < lowest) continue;
    findings.push({
      kind: 'out-of-order',
      path: file.path,
      branch: branch.name,
      number: file.number,
      numberText: file.numberText,
      message:
        `the number ${file.number} is not the lowest of the numbers that follow it in the branch ` +
        `"${branch.name}": the number ${lowest} follows it in the order the runner applies the files`,
    });
    break;
  }

  // A file that carries no number at all.
  for (const file of branch.unnumbered) {
    findings.push({
      kind: 'unnumbered',
      path: file.path,
      branch: file.branch,
      message: `the file does not start with a number, so it cannot be sequenced`,
    });
  }
}

/**
 * Check the numbers that are used by more than one migration. A number that
 * is only unique within a branch is not unique at all.
 */
function checkCollisions(branches, findings) {
  const byNumber = new Map();
  for (const branch of branches) {
    for (const file of branch.files) {
      if (file.direction !== 'up') continue;
      const list = byNumber.get(file.number) ?? [];
      list.push({ branch: branch.name, path: file.path, numberText: file.numberText });
      byNumber.set(file.number, list);
    }
  }

  for (const [number, entries] of byNumber) {
    // The same file in two branches is one migration that both branches
    // carry, and not two migrations that collide.
    const paths = [...new Set(entries.map((entry) => entry.path))];
    if (paths.length < 2) continue;
    findings.push({
      kind: 'cross-branch-collision',
      path: entries[0].path,
      number,
      numberText: entries[0].numberText,
      branches: [...new Set(entries.map((entry) => entry.branch))],
      message:
        `the number ${number} is used by more than one migration: ` +
        entries.map((entry) => `${entry.branch} (${entry.path})`).join(', '),
    });
  }
}

/** Read every branch the checker was asked to look at. */
function readBranches(repo, options) {
  const branches = [];
  const names = options.branches ?? listLocalBranches(repo);

  if (names.length === 0) {
    // Without branches there is no history to read, so the working tree is
    // checked on its own.
    branches.push({
      name: WORKING_TREE_BRANCH,
      files: listFilesInDirectory(repo, options.directory),
    });
    return branches;
  }

  for (const name of names) {
    const files = listFilesInTree(repo, name, options.directory);
    if (files === null) {
      return { error: `the branch "${name}" cannot be read from the repository` };
    }
    branches.push({ name, files });
  }
  return branches;
}

/** Check a whole repository and return the findings. */
function checkRepository(repo, options) {
  const read = readBranches(repo, options);
  if (read.error) return read;

  const branches = read.map((branch) => readBranchMigrations(repo, branch, options));
  const findings = [];
  for (const branch of branches) checkBranch(branch, findings);
  checkCollisions(branches, findings);
  return { findings };
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/** The environment that keeps a throwaway repository free of the machine. */
function fixtureEnvironment(root) {
  const empty = join(root, 'gitconfig-empty');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_SYSTEM: empty,
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
function fixtureGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: fixtureEnvironment(root),
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

/** Remove a file from a throwaway repository. */
function rmFixture(root, name) {
  rmSync(join(root, name), { force: true });
}

/** A migration file has a body, but the checker never reads it. */
function migration(body) {
  return `-- ${body}\n`;
}

/** Build a throwaway repository and return its path. */
function createFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), 'check-migrations-self-test-'));
  writeFileSync(join(root, 'gitconfig-empty'), '', 'utf8');
  fixtureGit(root, ['init', '--quiet', '.']);
  fixtureGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return root;
}

/** Write the migrations of a branch and commit them. */
function commitMigrations(root, message, files) {
  for (const [name, content] of files) writeFixture(root, name, content);
  fixtureGit(root, ['add', '--all']);
  fixtureGit(root, ['commit', '--quiet', '--message', message]);
}

/** The cases of the self-test: each one builds a repository and looks for a finding. */
function selfTestCases() {
  return [
    {
      name: 'two branches that reuse a number',
      must: 'the number used by both branches must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000002_first.up.sql', migration('first')],
          ['migrations/000002_first.down.sql', migration('first')],
        ]);
        fixtureGit(root, ['checkout', '--quiet', '-b', 'feature-a']);
        rmFixture(root, 'migrations/000002_first.up.sql');
        rmFixture(root, 'migrations/000002_first.down.sql');
        commitMigrations(root, 'feature', [
          ['migrations/000002_second.up.sql', migration('second')],
          ['migrations/000002_second.down.sql', migration('second')],
        ]);
        fixtureGit(root, ['checkout', '--quiet', 'main']);
      },
      expect: (findings) => {
        const collision = findings.find((finding) => finding.kind === 'cross-branch-collision' && finding.number === 2);
        if (!collision) return false;
        // The finding has to name the branches that carry the number.
        return Array.isArray(collision.branches) && collision.branches.length === 2;
      },
    },
    {
      name: 'one branch with two files that carry one number',
      must: 'the number used twice in one branch must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000002_one.up.sql', migration('one')],
          ['migrations/000002_two.up.sql', migration('two')],
          ['migrations/000002_one.down.sql', migration('one')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'duplicate-in-branch' && finding.number === 2),
    },
    {
      name: 'a migration without a down file',
      must: 'the missing down file must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000002_add.up.sql', migration('add')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'missing-down' && finding.number === 2),
    },
    {
      name: 'a migration without an up file',
      must: 'the missing up file must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000002_add.down.sql', migration('add')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'missing-up' && finding.number === 2),
    },
    {
      name: 'a gap in the numbering',
      must: 'the gap must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000004_add.up.sql', migration('add')],
          ['migrations/000004_add.down.sql', migration('add')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'gap'),
    },
    {
      name: 'numbers that do not ascend in the order the runner applies the files',
      must: 'the out of order number must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/9_nine.up.sql', migration('nine')],
          ['migrations/9_nine.down.sql', migration('nine')],
          ['migrations/10_ten.up.sql', migration('ten')],
          ['migrations/10_ten.down.sql', migration('ten')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'out-of-order'),
    },
    {
      name: 'a migration file that carries no number',
      must: 'the file without a number must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/alpha_beta.up.sql', migration('alpha')],
          ['migrations/alpha_beta.down.sql', migration('alpha')],
        ]);
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'unnumbered'),
    },
    {
      name: 'a healthy set of migrations',
      must: 'nothing must be reported',
      build(root) {
        commitMigrations(root, 'base', [
          ['migrations/000001_base.up.sql', migration('base')],
          ['migrations/000001_base.down.sql', migration('base')],
          ['migrations/000002_add.up.sql', migration('add')],
          ['migrations/000002_add.down.sql', migration('add')],
        ]);
      },
      expect: (findings) => findings.length === 0,
    },
  ];
}

/** Run every case of the self-test and report the ones that fail. */
function runSelfTest() {
  const failures = [];
  const cases = selfTestCases();

  for (const testCase of cases) {
    const root = createFixtureRepository();
    try {
      testCase.build(root);
      const result = checkRepository(root, {
        directory: DEFAULT_DIRECTORY,
        pattern: DEFAULT_PATTERN,
        downPattern: deriveDownPattern(DEFAULT_PATTERN),
        branches: null,
      });
      if (result.error) {
        failures.push(`${testCase.name}: ${result.error}`);
        continue;
      }
      if (!testCase.expect(result.findings)) {
        failures.push(`${testCase.name}: ${testCase.must}`);
      }
    } catch (error) {
      failures.push(`${testCase.name}: the repository could not be built (${error.message})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    process.stdout.write('check-migrations self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`check-migrations self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'check-migrations — check the numbering of the migrations of a repository.',
      '',
      'Usage:',
      '  node scripts/check-migrations.mjs [options]',
      '',
      'Options:',
      '  --repo <dir>          The repository to check. Default: the repository',
      '                        the script lives in.',
      '  --dir <path>          The directory that holds the migrations.',
      '                        Default: migrations.',
      '  --pattern <glob>      The pattern that matches a migration file.',
      '                        Default: *_*.up.sql.',
      '  --down-pattern <glob> The pattern that matches a rollback file. Default:',
      '                        the pattern above with up replaced by down.',
      '  --branches <a,b,c>    The branches to read. Default: the local branches.',
      '  --json                Print the findings as JSON instead of text.',
      '  --quiet               Print the findings but not the closing summary.',
      '  --self-test           Check the checker against throwaway repositories.',
      '  --help                Print this help and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one finding, or the self-test failed.',
      '  2  the command line could not be understood.',
      '',
      'The checker reads the committed state of every branch. It never runs a',
      'migration, never touches a database and never writes to the repository.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = {
    repo: null,
    directory: DEFAULT_DIRECTORY,
    pattern: DEFAULT_PATTERN,
    downPattern: null,
    branches: null,
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
    else if (argument === '--repo' || argument === '--dir' || argument === '--pattern' ||
             argument === '--down-pattern' || argument === '--branches') {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        process.stderr.write(`check-migrations: the option "${argument}" needs a value\n`);
        return null;
      }
      if (argument === '--repo') options.repo = value;
      else if (argument === '--dir') options.directory = value;
      else if (argument === '--pattern') options.pattern = value;
      else if (argument === '--down-pattern') options.downPattern = value;
      else options.branches = value.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
    } else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    else if (argument.startsWith('--dir=')) options.directory = argument.slice('--dir='.length);
    else if (argument.startsWith('--pattern=')) options.pattern = argument.slice('--pattern='.length);
    else if (argument.startsWith('--down-pattern=')) options.downPattern = argument.slice('--down-pattern='.length);
    else if (argument.startsWith('--branches=')) {
      options.branches = argument
        .slice('--branches='.length)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    } else {
      process.stderr.write(`check-migrations: the option "${argument}" is not known\n`);
      return null;
    }
  }

  return options;
}

/** Print the findings. */
function report(findings, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ count: findings.length, findings }, null, 2)}\n`);
    return;
  }
  for (const finding of findings) {
    process.stdout.write(`${finding.path}: [${finding.kind}] ${finding.message}\n`);
  }
  if (!options.quiet) {
    process.stdout.write(`check-migrations: ${findings.length} finding(s)\n`);
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
    process.stderr.write(`check-migrations: the directory "${repo}" does not exist\n`);
    return 2;
  }

  options.downPattern = options.downPattern ?? deriveDownPattern(options.pattern);
  const result = checkRepository(repo, options);
  if (result.error) {
    process.stderr.write(`check-migrations: ${result.error}\n`);
    return 2;
  }

  report(result.findings, options);
  return result.findings.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
