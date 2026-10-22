/**
 * git.mjs — the git interface that the checks share.
 *
 * Everything in the first part of this file reads. No function writes to a
 * repository, changes the index, checks anything out, stashes anything,
 * fetches anything, merges anything or builds anything. The commands that are
 * used are the read-only ones: rev-parse, rev-list, merge-base, ls-tree,
 * ls-files, diff and for-each-ref.
 *
 * The second part builds a throwaway repository for the self-tests. It is the
 * only part that writes, it writes inside a temporary directory, and it never
 * touches the repository that is being checked.
 *
 * The module uses nothing but the Node standard library. Git is called with an
 * argument list and never through a shell, so it runs the same way on Linux,
 * macOS and Windows.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// The biggest output the helpers will read. A repository with a very large
// tree can produce a lot of text.
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

/** Run git in a repository and return what it wrote. */
export function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run git and return what it wrote, or null when the command failed. */
export function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

/** Run git and return its output as a list of lines without the empty ones. */
export function gitLines(repo, args) {
  const output = tryGit(repo, args);
  if (output === null) return [];
  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The root of the repository, or null when the directory is not in one. */
export function repositoryRoot(repo) {
  const output = tryGit(repo, ['rev-parse', '--show-toplevel']);
  if (output === null) return null;
  const root = output.trim();
  return root.length > 0 ? root : null;
}

/** Resolve a name to a commit, or null when the name is unknown. */
export function revParse(repo, ref) {
  const output = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (output === null) return null;
  const hash = output.trim();
  return hash.length > 0 ? hash : null;
}

/** True when the first commit is an ancestor of the second one. */
export function isAncestor(repo, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repo,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** The common ancestor of two commits, or null when there is none. */
export function mergeBase(repo, first, second) {
  const output = tryGit(repo, ['merge-base', first, second]);
  if (output === null) return null;
  const hash = output.trim();
  return hash.length > 0 ? hash : null;
}

/**
 * How many commits each side has that the other side does not have. The
 * result counts the commits of the second side as ahead and the commits of
 * the first side as behind.
 */
export function aheadBehind(repo, from, to) {
  const output = tryGit(repo, ['rev-list', '--left-right', '--count', `${from}...${to}`]);
  if (output === null) return { ahead: 0, behind: 0 };
  const parts = output.trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  return { behind: Number(parts[0]), ahead: Number(parts[1]) };
}

/** The paths in a commit, relative to the root of the repository. */
export function treePaths(repo, commit) {
  const output = tryGit(repo, ['ls-tree', '-r', '-z', '--name-only', commit]);
  if (output === null) return [];
  return output.split('\0').filter((path) => path.length > 0);
}

/**
 * The paths in the index, which is what the next commit would record. A
 * path that is still in conflict is in the index as well, so a conflict is
 * never reported as a lost file.
 */
export function indexPaths(repo) {
  const output = tryGit(repo, ['ls-files', '-z', '--stage', '--full-name']);
  if (output === null) return [];
  const paths = [];
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    paths.push(entry.slice(tab + 1));
  }
  return paths;
}

/**
 * The change kinds between two commits, keyed by path. A renamed path is
 * recorded twice: the destination is recorded as renamed and the source is
 * recorded as renamed-away, so a caller can ask what happened to either
 * name.
 */
export function diffKinds(repo, from, to) {
  const kinds = new Map();
  const output = tryGit(repo, ['diff', '--name-status', '--find-renames', '-z', from, to]);
  if (output === null) return kinds;
  const parts = output.split('\0').filter((part) => part.length > 0);

  let index = 0;
  while (index < parts.length) {
    const status = parts[index];
    index += 1;
    const letter = status[0];

    if (letter === 'R' || letter === 'C') {
      const source = parts[index];
      index += 1;
      const destination = parts[index];
      index += 1;
      if (letter === 'R') {
        kinds.set(destination, { kind: 'renamed', source });
        kinds.set(source, { kind: 'renamed-away', destination });
      } else {
        kinds.set(destination, { kind: 'copied', source });
      }
      continue;
    }

    const path = parts[index];
    index += 1;
    kinds.set(path, { kind: describeKind(letter) });
  }

  return kinds;
}

/** The name of a change kind for the letter that a diff uses for it. */
function describeKind(letter) {
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  if (letter === 'M') return 'modified';
  if (letter === 'T') return 'type-changed';
  if (letter === 'U') return 'unmerged';
  return 'changed';
}

/** The paths that differ between two commits. */
export function changedPaths(repo, from, to) {
  const output = tryGit(repo, ['diff', '--name-only', '-z', from, to]);
  if (output === null) return [];
  return output.split('\0').filter((path) => path.length > 0);
}

/** The local branches of the repository. */
export function localBranches(repo) {
  return gitLines(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
}

/** The branch that is checked out, or null when the head is detached. */
export function currentBranch(repo) {
  const output = tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (output === null) return null;
  const name = output.trim();
  return name.length > 0 ? name : null;
}

/** The short form of a commit, which is what the reports use. */
export function shortHash(hash) {
  if (!hash) return 'unknown';
  return hash.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Building a throwaway repository
// ---------------------------------------------------------------------------

/**
 * Build a throwaway repository in a temporary directory. The self-tests use
 * it and nothing else does. Every write lands inside the temporary directory,
 * and the caller removes the directory when it is done with it.
 */
export function createTemporaryRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));

  const run = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  run(['init', '--quiet']);
  // The identity is a placeholder. The repository lives in a temporary
  // directory and its history is thrown away when the test is over.
  run(['config', 'user.name', 'Repository Check']);
  run(['config', 'user.email', 'check@example.invalid']);
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'core.autocrlf', 'false']);
  // The branch is named here, so the test does not depend on the default
  // branch name of the machine that runs it.
  run(['symbolic-ref', 'HEAD', 'refs/heads/main']);

  return {
    root,

    /** Run a git command in the throwaway repository. */
    git: run,

    /** Write a file into the throwaway repository. */
    write(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    },

    /** Write a file, stage everything and commit it. */
    commit(path, content, message) {
      if (path !== null && path !== undefined) this.write(path, content);
      run(['add', '--all']);
      run(['commit', '--quiet', '--message', message]);
    },

    /** Remove the throwaway repository and everything in it. */
    remove() {
      // A file handle can survive the command that used it for a moment on
      // Windows, so the removal is retried before it is given up on.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
