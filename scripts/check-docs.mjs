#!/usr/bin/env node
/**
 * check-docs.mjs — a documentation checker for this repository.
 *
 * The checker reads every markdown file and proves five things about it:
 *
 *   1. the file has exactly one top level heading;
 *   2. every relative link in it resolves to a file that exists;
 *   3. the file has no tab character;
 *   4. the file has no trailing whitespace;
 *   5. every fenced code block in it carries a language tag.
 *
 * On top of that it reads the table of contents of the readme, the part that
 * sits between a <!-- toc --> marker, and checks that it lists exactly the
 * documents that exist.
 *
 * The checker uses nothing but the Node standard library, it runs the same way
 * on Linux, macOS and Windows, and it needs no installation step.
 *
 * Usage:
 *   node scripts/check-docs.mjs [options]
 *
 * Options:
 *   --root <dir>  Check another directory. Default: the repository root.
 *   --self-test   Check the checker against a small temporary fixture.
 *   --help        Print this help and exit.
 *
 * Exit codes:
 *   0  no problem was found, or the self-test passed.
 *   1  at least one problem was found, or the self-test failed.
 *   2  the command line could not be understood.
 *
 * What counts as a document that the table of contents has to list:
 *   Every markdown file in the repository, except the file that holds the
 *   marker itself, except the readme of a folder, because a folder readme is
 *   read from the folder and not from the table of contents, and except the
 *   forms and the templates under .github, which are part of the machinery
 *   of the repository rather than documents a reader has to find.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import process from 'node:process';

// The marker that opens the table of contents in the readme.
const TOC_MARKER = '<!-- toc -->';

// The marker that closes the table of contents, when one is used.
const TOC_END_MARKER = '<!-- /toc -->';

// Directories that never hold documentation.
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.idea',
  '.vscode',
  '.terraform',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/** True when a directory never holds documentation. */
function isSkippedDirectory(name) {
  if (SKIPPED_DIRECTORIES.has(name)) return true;
  return name.startsWith('.') && name !== '.github';
}

// ---------------------------------------------------------------------------
// Reading the documents
// ---------------------------------------------------------------------------

/** List every markdown file under a root. */
function collectMarkdownFiles(root) {
  const files = [];
  const queue = [root];
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
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) queue.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

/**
 * Read one markdown file and work out where its code fences are. A fence is
 * opened by three or more backticks or tildes and closed by a line that
 * carries nothing but the same character.
 */
function readDocument(filePath, root) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const inFence = new Array(lines.length).fill(false);
  const fences = [];
  let open = null;

  lines.forEach((line, index) => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (match) {
        open = { character: match[1][0], length: match[1].length };
        fences.push({ index, info: match[2].trim() });
        inFence[index] = true;
      }
      return;
    }
    inFence[index] = true;
    if (
      match &&
      match[1][0] === open.character &&
      match[1].length >= open.length &&
      match[2].trim() === ''
    ) {
      open = null;
    }
  });

  return {
    absPath: filePath,
    relPath: toPosix(relative(root, filePath)),
    lines,
    inFence,
    fences,
  };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Rule one: exactly one top level heading. */
function checkHeadings(document) {
  const problems = [];
  const headings = [];
  document.lines.forEach((line, index) => {
    if (document.inFence[index]) return;
    if (/^ {0,3}#\s+\S/.test(line)) headings.push(index + 1);
  });
  if (headings.length !== 1) {
    problems.push(
      `${document.relPath}: has ${headings.length} top level heading(s), exactly one is required` +
        (headings.length > 0 ? ` (line ${headings.join(', ')})` : ''),
    );
  }
  return problems;
}

/** Rule two: every relative link resolves to a file that exists. */
function checkLinks(document, root) {
  const problems = [];
  for (const target of extractLinkTargets(document)) {
    if (isExternalTarget(target)) continue;
    if (target.startsWith('#')) continue;
    if (target.startsWith('/')) continue;
    const path = target.split('#')[0].split('?')[0];
    if (path.length === 0) continue;
    const resolved = resolve(dirname(document.absPath), path);
    if (!existsSync(resolved)) {
      problems.push(`${document.relPath}: the link "${target}" does not resolve to a file that exists`);
    }
  }
  return problems;
}

/** Rule three and four: no tab character and no trailing whitespace. */
function checkWhitespace(document) {
  const problems = [];
  document.lines.forEach((line, index) => {
    if (line.includes('\t')) {
      problems.push(`${document.relPath}:${index + 1}: the line contains a tab character`);
    }
    if (/[ ]+$/.test(line)) {
      problems.push(`${document.relPath}:${index + 1}: the line has trailing whitespace`);
    }
  });
  return problems;
}

/** Rule five: every fenced code block carries a language tag. */
function checkFences(document) {
  const problems = [];
  for (const fence of document.fences) {
    if (fence.info.length === 0) {
      problems.push(`${document.relPath}:${fence.index + 1}: the code block has no language tag`);
    }
  }
  return problems;
}

/** Rule six: the table of contents lists exactly the documents that exist. */
function checkTableOfContents(documents, root) {
  const problems = [];
  const hosts = documents.filter((document) => document.lines.some((line) => line.includes(TOC_MARKER)));

  for (const host of hosts) {
    const listed = listedDocuments(host, root);
    for (const entry of listed) {
      if (!documents.some((document) => document.relPath === entry)) {
        problems.push(`${host.relPath}: the table of contents lists "${entry}" but no such document exists`);
      }
    }
    for (const document of documents) {
      if (!mustBeListed(document, host)) continue;
      if (!listed.includes(document.relPath)) {
        problems.push(`${host.relPath}: the table of contents does not list the existing document "${document.relPath}"`);
      }
    }
  }

  return problems;
}

/** True when a document has to appear in the table of contents. */
function mustBeListed(document, host) {
  if (document.relPath === host.relPath) return false;
  // A folder readme is read from the folder, not from the table of contents.
  if (basename(document.relPath).toLowerCase() === 'readme.md') return false;
  // The forms and the templates under .github are part of the machinery of
  // the repository, not documents a reader has to find.
  if (document.relPath.startsWith('.github/')) return false;
  return true;
}

/** Read the documents that the table of contents of one host lists. */
function listedDocuments(host, root) {
  const start = host.lines.findIndex((line) => line.includes(TOC_MARKER));
  if (start === -1) return [];

  let end = host.lines.length;
  const explicit = host.lines.findIndex((line, index) => index > start && line.includes(TOC_END_MARKER));
  if (explicit !== -1) {
    end = explicit;
  } else {
    // Without an end marker the table of contents ends where the next
    // section of the readme begins.
    for (let index = start + 1; index < host.lines.length; index += 1) {
      if (host.inFence[index]) continue;
      if (/^ {0,3}#{1,2}\s+\S/.test(host.lines[index])) {
        end = index;
        break;
      }
    }
  }

  const listed = [];
  for (let index = start + 1; index < end; index += 1) {
    if (host.inFence[index]) continue;
    for (const target of extractLinkTargets({ lines: [host.lines[index]], inFence: [false] })) {
      if (!/\.md$/i.test(target)) continue;
      const path = target.split('#')[0].split('?')[0];
      if (path.length === 0) continue;
      listed.push(toPosix(relative(root, resolve(dirname(host.absPath), path))));
    }
  }
  return listed;
}

/** Collect the targets of the links in a set of lines. */
function extractLinkTargets(document) {
  const targets = [];
  document.lines.forEach((line, index) => {
    if (document.inFence && document.inFence[index]) return;

    const inline = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
    let match = inline.exec(line);
    while (match !== null) {
      targets.push(cleanTarget(match[1]));
      match = inline.exec(line);
    }

    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (definition) targets.push(cleanTarget(definition[1]));
  });
  return targets;
}

/** Strip the decoration from the target of a link. */
function cleanTarget(target) {
  let value = target.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  return value;
}

/** True when the target points somewhere outside the repository. */
function isExternalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

// ---------------------------------------------------------------------------
// Running the checker
// ---------------------------------------------------------------------------

/** Check a whole directory and return the problems that were found. */
function checkRepository(root) {
  const documents = collectMarkdownFiles(root).map((file) => readDocument(file, root));
  const problems = [];
  for (const document of documents) {
    problems.push(...checkHeadings(document));
    problems.push(...checkLinks(document, root));
    problems.push(...checkWhitespace(document));
    problems.push(...checkFences(document));
  }
  problems.push(...checkTableOfContents(documents, root));
  return problems;
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/** Write a file into a fixture and return its path. */
function writeFixture(root, name, content) {
  const path = join(root, name);
  const folder = dirname(path);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Build a small tree of markdown files and check the rules against it. */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-self-test-'));

  writeFixture(
    root,
    'README.md',
    [
      '# Fixture',
      '',
      '<!-- toc -->',
      '- [Guide](guide.md)',
      '<!-- /toc -->',
      '',
      '## Section',
      '',
      'See [the guide](guide.md).',
      '',
      '```text',
      'echo hello',
      '```',
      '',
    ].join('\n'),
  );

  writeFixture(
    root,
    'guide.md',
    ['# Guide', '', 'Nothing wrong here.', '', '```bash', 'echo hello', '```', ''].join('\n'),
  );

  writeFixture(root, 'two-headings.md', ['# One', '', '# Two', ''].join('\n'));
  writeFixture(root, 'broken-link.md', ['# Broken', '', 'See [nothing](missing-file.md).', ''].join('\n'));
  writeFixture(root, 'tab.md', ['# Tab', '', 'a\tb', ''].join('\n'));
  writeFixture(root, 'trailing.md', ['# Trailing', '', 'a line with trailing space ', ''].join('\n'));
  writeFixture(root, 'no-language.md', ['# No language', '', '```', 'echo hello', '```', ''].join('\n'));

  return root;
}

/** Run the checker against the fixture and report the failures. */
function runSelfTest() {
  const failures = [];
  const root = buildFixture();

  try {
    const documents = collectMarkdownFiles(root).map((file) => readDocument(file, root));
    const byName = (name) => documents.find((document) => document.relPath === name);

    const expectations = [
      ['guide.md', (problems) => problems.length === 0, 'the good document must have no problem'],
      [
        'two-headings.md',
        (problems) => problems.some((problem) => problem.includes('top level heading')),
        'two top level headings must be reported',
      ],
      [
        'broken-link.md',
        (problems) => problems.some((problem) => problem.includes('does not resolve')),
        'a link to a missing file must be reported',
      ],
      ['tab.md', (problems) => problems.some((problem) => problem.includes('tab')), 'a tab must be reported'],
      [
        'trailing.md',
        (problems) => problems.some((problem) => problem.includes('trailing whitespace')),
        'trailing whitespace must be reported',
      ],
      [
        'no-language.md',
        (problems) => problems.some((problem) => problem.includes('language tag')),
        'a code block without a language must be reported',
      ],
    ];

    for (const [name, check, message] of expectations) {
      const document = byName(name);
      if (!document) {
        failures.push(`the fixture is missing "${name}"`);
        continue;
      }
      const problems = [
        ...checkHeadings(document),
        ...checkLinks(document, root),
        ...checkWhitespace(document),
        ...checkFences(document),
      ];
      if (!check(problems)) {
        failures.push(message);
      }
    }

    // The table of contents has to list exactly the documents that exist.
    const tocRoot = mkdtempSync(join(tmpdir(), 'check-docs-self-test-toc-'));
    try {
      writeFixture(
        tocRoot,
        'README.md',
        [
          '# Table of contents',
          '',
          '<!-- toc -->',
          '- [Gone](gone.md)',
          '<!-- /toc -->',
          '',
          '## Section',
          '',
          '```text',
          'echo hello',
          '```',
          '',
        ].join('\n'),
      );
      writeFixture(tocRoot, 'present.md', ['# Present', ''].join('\n'));

      const tocDocuments = collectMarkdownFiles(tocRoot).map((file) => readDocument(file, tocRoot));
      const tocProblems = checkTableOfContents(tocDocuments, tocRoot);
      if (!tocProblems.some((problem) => problem.includes('gone.md'))) {
        failures.push('a listed document that does not exist must be reported');
      }
      if (!tocProblems.some((problem) => problem.includes('present.md'))) {
        failures.push('an existing document that is not listed must be reported');
      }
    } finally {
      rmSync(tocRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stdout.write('check-docs self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write('check-docs self-test: passed (6 rules, 2 fixtures)\n');
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'check-docs — check the documentation of this repository.',
      '',
      'Usage:',
      '  node scripts/check-docs.mjs [options]',
      '',
      'Options:',
      '  --root <dir>  Check another directory. Default: the repository root.',
      '  --self-test   Check the checker against a small temporary fixture.',
      '  --help        Print this help and exit.',
      '',
      'Exit codes:',
      '  0  no problem was found, or the self-test passed.',
      '  1  at least one problem was found, or the self-test failed.',
      '  2  the command line could not be understood.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = { root: null, selfTest: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--root' || argument === '--dir') {
      index += 1;
      options.root = argv[index];
    } else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length);
    else {
      process.stderr.write(`check-docs: the option "${argument}" is not known\n`);
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

  const root = resolve(options.root ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  if (!existsSync(root)) {
    process.stderr.write(`check-docs: the directory "${root}" does not exist\n`);
    return 2;
  }

  const problems = checkRepository(root);
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  if (problems.length > 0) {
    process.stdout.write(`check-docs: ${problems.length} problem(s)\n`);
    return 1;
  }
  process.stdout.write('check-docs: no problem found\n');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
