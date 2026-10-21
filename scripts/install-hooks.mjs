#!/usr/bin/env node
/**
 * install-hooks.mjs — install the managed pre-commit hook.
 *
 * The hook runs the leak scanner over the files that are staged for the
 * commit. When the scanner finds something the commit is refused, and the
 * message explains how to bypass the hook on purpose and what a bypass
 * leaves behind in the history.
 *
 * The installer is careful with a hook it did not write itself:
 *   - a hook that this script wrote is replaced, so running the installer
 *     twice changes nothing;
 *   - a hook that this script did not write is never overwritten without a
 *     clear instruction, and it is offered to be backed up first.
 *
 * The installer uses nothing but the Node standard library.
 *
 * Usage:
 *   node scripts/install-hooks.mjs [options]
 *
 * Options:
 *   --backup  Move an existing hook that this script did not write to a
 *             backup file, and then install the managed hook.
 *   --force   Overwrite an existing hook that this script did not write,
 *             without keeping a backup.
 *   --help    Print this help and exit.
 *
 * Exit codes:
 *   0  the managed hook is in place.
 *   1  nothing was installed, because the installer needed an instruction.
 *   2  the command line could not be understood, or this is not a git
 *      repository.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// The line that marks a hook as one this script wrote.
const MARKER = 'managed-by: scripts/install-hooks.mjs';

// The hook itself. It is a small POSIX shell script, because that is what git
// runs on every platform it supports.
const HOOK = `#!/bin/sh
# ${MARKER}
#
# This hook runs the leak scanner over the files that are staged for this
# commit. It is written by scripts/install-hooks.mjs and it is replaced
# whenever that script is run again, so it is not edited by hand.
#
# The scanner is asked for the staged files only, so a finding that is not
# part of this commit never blocks the commit.
set -eu

repository=$(git rev-parse --show-toplevel)
cd "$repository"

if node scripts/scan-leaks.mjs --quiet --staged; then
  exit 0
fi

echo "pre-commit: the leak scan found something, so the commit was refused."
echo ""
echo "Run 'node scripts/scan-leaks.mjs' to see every finding, fix them, and commit again."
echo ""
echo "If the finding is a false positive, you can bypass this hook on purpose:"
echo "    git commit --no-verify"
echo ""
echo "A bypass is visible in the commit history. It is a deliberate choice, not a quiet one."
exit 1
`;

// ---------------------------------------------------------------------------
// Finding the place where the hook belongs
// ---------------------------------------------------------------------------

/** Find the directory that holds the hooks of this repository. */
function findHooksDirectory(root) {
  const gitPath = join(root, '.git');
  let stats;
  try {
    stats = statSync(gitPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return join(gitPath, 'hooks');

  // A linked worktree keeps a pointer to the real git directory.
  const pointer = readFileSync(gitPath, 'utf8');
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  return join(resolve(root, match[1].trim()), 'hooks');
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'install-hooks — install the managed pre-commit hook.',
      '',
      'Usage:',
      '  node scripts/install-hooks.mjs [options]',
      '',
      'Options:',
      '  --backup  Back up an existing hook that this script did not write, and',
      '            then install the managed hook.',
      '  --force   Overwrite an existing hook that this script did not write,',
      '            without keeping a backup.',
      '  --help    Print this help and exit.',
      '',
      'Exit codes:',
      '  0  the managed hook is in place.',
      '  1  nothing was installed, because the installer needed an instruction.',
      '  2  the command line could not be understood, or this is not a git',
      '     repository.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = { backup: false, force: false, help: false };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--backup') options.backup = true;
    else if (argument === '--force') options.force = true;
    else {
      process.stderr.write(`install-hooks: the option "${argument}" is not known\n`);
      return null;
    }
  }
  return options;
}

/** Find a free name for a backup of the hook. */
function findBackupPath(hookPath) {
  let candidate = `${hookPath}.backup`;
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = `${hookPath}.backup.${counter}`;
    counter += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Installing the hook
// ---------------------------------------------------------------------------

/** Install the managed hook and report what was done. */
function install(options) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const hooksDirectory = findHooksDirectory(root);

  if (hooksDirectory === null) {
    process.stderr.write(
      'install-hooks: this directory is not a git repository, so there is nowhere to put a hook.\n',
    );
    return 2;
  }

  const hookPath = join(hooksDirectory, 'pre-commit');
  const exists = existsSync(hookPath);
  const current = exists ? readFileSync(hookPath, 'utf8') : '';
  const isManaged = current.includes(MARKER);

  if (exists && !isManaged && !options.backup && !options.force) {
    process.stdout.write(
      [
        `install-hooks: a pre-commit hook is already there at ${hookPath}, and this script did not write it.`,
        'install-hooks: it was left exactly as it was.',
        'install-hooks: run this again with --backup to move it aside and install the managed hook,',
        'install-hooks: or with --force to overwrite it. A hook that is in charge of a commit belongs',
        'install-hooks: to a person, so read the existing hook before it is replaced.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (exists && !isManaged && options.backup) {
    const backupPath = findBackupPath(hookPath);
    copyFileSync(hookPath, backupPath);
    process.stdout.write(`install-hooks: the existing hook was copied to ${backupPath}\n`);
  }

  if (exists && isManaged && current === HOOK) {
    process.stdout.write(`install-hooks: the managed hook at ${hookPath} is already up to date\n`);
    return 0;
  }

  writeFileSync(hookPath, HOOK, { encoding: 'utf8', mode: 0o755 });
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Some file systems do not carry the permission bits. The hook still
    // works there, because git runs it through the shell.
  }

  process.stdout.write(
    [
      `install-hooks: wrote the pre-commit hook to ${hookPath}`,
      'install-hooks: the hook runs the leak scanner over the staged files of every commit,',
      'install-hooks: and it refuses the commit when the scanner finds something.',
      'install-hooks: a deliberate bypass is possible with git commit --no-verify, and it stays',
      'install-hooks: visible in the commit history.',
      '',
    ].join('\n'),
  );
  return 0;
}

/** Run the installer. */
function main(argv) {
  const options = parseArguments(argv);
  if (options === null) return 2;
  if (options.help) {
    printUsage();
    return 0;
  }
  return install(options);
}

process.exitCode = main(process.argv.slice(2));
