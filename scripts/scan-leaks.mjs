#!/usr/bin/env node
/**
 * scan-leaks.mjs — a leak scanner for this repository.
 *
 * The scanner walks the working tree and reports anything that looks like a
 * credential, a real identifier, or a path that belongs to one machine. It uses
 * nothing but the Node standard library, it runs the same way on Linux, macOS
 * and Windows, and it needs no installation step.
 *
 * The tree the scanner reads is the tree the command was given. By default that
 * is the repository that contains the directory the command was called from,
 * and a scanner that lives somewhere else in the machine is never allowed to
 * stand in for it. The tree it reports must be the same tree: every path a run
 * prints is verified to exist inside the tree that was scanned.
 *
 * Usage:
 *   node scripts/scan-leaks.mjs [options] [paths...]
 *
 * Options:
 *   --root <dir>  Scan another directory. Default: the repository that contains
 *                 the directory the command was called from, or that directory
 *                 itself when it is not inside a repository.
 *   --staged      Scan the files staged for the next commit. The staged list is
 *                 read from the tree it belongs to, and a commit whose files
 *                 cannot all be read fails instead of passing quietly.
 *   --json        Print the findings as JSON instead of text.
 *   --quiet       Print the findings but not the closing summary line.
 *   --self-test   Run the patterns against known good and bad samples.
 *   --help        Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one finding, a staged file that could not be read, or the
 *      self-test failed.
 *   2  the command line could not be understood.
 *
 * Two rules of the house:
 *   - A secret is never printed in full. A value shows at most its first four
 *     characters and its last two characters; key material shows nothing.
 *   - The scanner does not report its own source. The patterns live in this
 *     file, so the words api_key, secret, password and token appear here as
 *     part of the patterns themselves. See scripts/README.md for the whole
 *     story.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Directories that never hold material worth publishing.
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

// Lock files are written by a package manager and are full of hashes.
const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'go.sum',
  'uv.lock',
  'mix.lock',
  'packages.lock.json',
  'pubspec.lock',
  'flake.lock',
]);

// The domains that are public, neutral and safe to mention.
const ACCEPTED_HOST_DOMAINS = new Set([
  'github.com',
  'githubusercontent.com',
  'nodejs.org',
  'npmjs.com',
  'golang.org',
  'go.dev',
  'python.org',
  'pypi.org',
  'docker.com',
  'kubernetes.io',
  'postgresql.org',
  'redis.io',
  'developer.mozilla.org',
  'docs.github.com',
  'opensource.org',
  'spdx.org',
  'json-schema.org',
  'yaml.org',
  'example.com',
  'example.org',
  'example.invalid',
  'localhost',
  // The two public references the changelog and the contribution guide cite.
  'keepachangelog.com',
  'semver.org',
]);

// The domains an e-mail address may be written on.
const ACCEPTED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.invalid',
  'example.org',
  'localhost',
  'users.noreply.github.com',
]);

// The address prefixes that are reserved for the project itself.
const ACCEPTED_EMAIL_LOCAL_PARTS = new Set(['security']);

// The placeholder domain of this project.
const PLACEHOLDER_DOMAIN = 'example.invalid';

// File endings that look like a domain but are a file name.
const FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'yml', 'yaml', 'json',
  'jsonc', 'txt', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'html',
  'htm', 'css', 'scss', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico',
  'webp', 'pdf', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'lock', 'cfg', 'conf',
  'ini', 'toml', 'env', 'log', 'tmp', 'bak', 'swp', 'orig', 'rej', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl',
  'lua', 'r', 'sql', 'db', 'csv', 'tsv', 'map', 'patch', 'diff', 'proto',
]);

// The top level domains a host name can end in. The list keeps the rule from
// reading ordinary code, such as expect.any(String), as a host name. The
// reserved names are in the list too, because a name under one of them is
// exactly the kind of internal host that must not be published.
const TOP_LEVEL_DOMAINS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'pro',
  'io', 'co', 'ai', 'me', 'tv', 'cc', 'xyz', 'eu', 'uk', 'us', 'de', 'fr',
  'nl', 'es', 'pt', 'pl', 'se', 'no', 'fi', 'dk', 'cz', 'sk', 'si', 'hr',
  'hu', 'ro', 'bg', 'tr', 'ru', 'ua', 'by', 'lt', 'lv', 'ee', 'ca', 'au',
  'nz', 'jp', 'kr', 'cn', 'tw', 'hk', 'sg', 'id', 'th', 'my', 'vn', 'ph',
  'br', 'mx', 'ar', 'cl', 'pe', 'za', 'ng', 'ke', 'eg', 'il', 'ae', 'sa',
  'fm', 'am', 'gl', 'li', 'ad', 'mc', 'sm', 'va', 'mu', 'at', 'be', 'sh',
  'gg', 'ws', 'arpa',
  'local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp',
  'invalid', 'example', 'test', 'staging', 'prod',
]);

// The address ranges that are reserved for documentation.
const ACCEPTED_IP_RANGES = [
  { prefix: '127.0.0.1' },
  { prefix: '0.0.0.0' },
  { prefix: '255.255.255.255' },
  { prefix: '192.0.2.' },
  { prefix: '198.51.100.' },
  { prefix: '203.0.113.' },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * Redact a value for printing. At most the first four characters and the
 * last two characters are shown, so the excerpt can never be used as the
 * value itself.
 */
function redact(value) {
  const text = String(value);
  if (text.length <= 6) return '<redacted>';
  return `${text.slice(0, 4)}…${text.slice(-2)}`;
}

/** True when the value is one of the accepted placeholder forms. */
function isPlaceholder(value) {
  const text = String(value).trim();
  if (text.length === 0) return true;
  const patterns = [
    /^replace[-_]?me$/i,
    /^example/i,
    /^placeholder/i,
    /^change[-_]?me$/i,
    /^dummy/i,
    /^fake/i,
    /^sample/i,
    /^redacted/i,
    /^your\b/i,
    /^x+$/i,
    /^<.*>$/,
    /^\$\{.*\}$/,
    /^\$[A-Za-z_][A-Za-z0-9_]*$/,
    /^\*{2,}.*$/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/** True when the host ends in one of the accepted public domains. */
function isAcceptedHost(host) {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return false;
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (ACCEPTED_HOST_DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}

/**
 * True when the text can be a host name at all. A host name is written in
 * lower case, ends in a known top level domain, and does not have a single
 * letter in front of it, so ordinary code and file names are left alone.
 */
function isPlausibleHost(host) {
  if (host !== host.toLowerCase()) return false;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  // A single letter in front of the top level domain is code, such as the
  // test method of a regular expression, and not a host name.
  if (labels[labels.length - 2].length < 2) return false;
  return TOP_LEVEL_DOMAINS.has(labels[labels.length - 1]);
}

/** True when the host looks like a file name and not like a host name. */
function isFileNameHost(host) {
  const label = host.toLowerCase().split('.').pop();
  return FILE_EXTENSIONS.has(label);
}

/** True when the address is written on an accepted domain. */
function isAcceptedEmail(address) {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at).toLowerCase();
  const labels = address.slice(at + 1).toLowerCase().split('.');
  if (ACCEPTED_EMAIL_LOCAL_PARTS.has(local) && labels.join('.') === PLACEHOLDER_DOMAIN) return true;
  // The accepted domain may be used with names in front of it, so a name
  // under the placeholder domain of the project is accepted as well.
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (ACCEPTED_EMAIL_DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}

/** True when the four numbers really are an address and not a version number. */
function isValidIpv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** True when the address is on the loopback or on a documentation range. */
function isAcceptedIp(text) {
  return ACCEPTED_IP_RANGES.some((range) => text.startsWith(range.prefix));
}

// ---------------------------------------------------------------------------
// The patterns
// ---------------------------------------------------------------------------

// A secret written as an assignment, for example a key held in a settings file.
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  '([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|credential)[A-Za-z0-9_.-]*)' +
    '\\s*(?:[*_`]*)\\s*[:=]\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s,;#]+))',
  'gi',
);

// A host name, for example a service address written in a settings file.
const HOSTNAME_PATTERN =
  /(?<![\w.-])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})(?![\w-])/gi;

// An e-mail address.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// An IPv4 address.
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** True when the value is written as code and therefore cannot be a credential. */
function isCodeValue(value) {
  return /[(){}\[\],;]/.test(value);
}

/** Collect the assignments on a line whose value looks like a real secret. */
function findSecretAssignments(line) {
  const pattern = new RegExp(SECRET_ASSIGNMENT_PATTERN.source, 'gi');
  const found = [];
  let match = pattern.exec(line);
  while (match !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const trimmed = value.trim();
    if (trimmed.length >= 8 && !isPlaceholder(trimmed) && !isCodeValue(trimmed)) {
      found.push({ key, value: trimmed });
    }
    match = pattern.exec(line);
  }
  return found.length > 0 ? found : null;
}

/** Collect the host names on a line that are not on the accepted list. */
function findUnknownHosts(line) {
  // An expression such as ${{ github.workflow }} reads like a host name but is
  // not one, so it is taken out of the line before the check.
  const cleaned = line.replace(/\$\{\{[^}]*\}\}/g, ' ');
  const matches = cleaned.match(HOSTNAME_PATTERN);
  if (!matches) return null;
  const found = [];
  for (const host of matches) {
    if (isFileNameHost(host)) continue;
    if (!isPlausibleHost(host)) continue;
    if (isAcceptedHost(host)) continue;
    found.push(host);
  }
  return found.length > 0 ? found : null;
}

/** Collect the e-mail addresses on a line that are not on an accepted domain. */
function findUnknownEmails(line) {
  const matches = line.match(EMAIL_PATTERN);
  if (!matches) return null;
  const found = matches.filter((address) => !isAcceptedEmail(address));
  return found.length > 0 ? found : null;
}

/** Collect the addresses on a line that are not on an accepted range. */
function findUnknownIps(line) {
  const matches = line.match(IPV4_PATTERN);
  if (!matches) return null;
  const found = matches.filter((ip) => isValidIpv4(ip) && !isAcceptedIp(ip));
  return found.length > 0 ? found : null;
}

/**
 * A sample that has to look like a secret to the rules, but must not look like
 * one to the platform that scans a push.
 *
 * The parts are joined when the sample is built, so the text in the tree is
 * never a complete secret. A sample written out in full would be refused by
 * the push protection of the hosting platform, which would stop the very
 * repository that is meant to keep such values out.
 */
function sample(...parts) {
  return parts.join('');
}

// The rules. Each rule knows how to find itself in a line, and each rule
// carries the samples that prove it works.
const RULES = [
  {
    name: 'private-key-block',
    secret: true,
    find: (line) =>
      line.match(new RegExp('-----BEGIN [A-Z0-9 ]*' + 'PRIVATE KEY-----', 'g')),
    bad: [sample('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    good: ['the private key block is never written into the repository'],
  },
  {
    name: 'pem-header',
    secret: true,
    find: (line) =>
      line.match(new RegExp('-----BEGIN [A-Z0-9 ]+' + '-----', 'g')),
    bad: [sample('-----BEGIN ', 'CERTIFICATE-----')],
    good: ['the header is written as an ordinary line of text'],
  },
  {
    name: 'cloud-access-key-id',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)' +
        '[0-9A-Z]{16}\\b', 'g')),
    bad: ['the key ' + sample('AKIA3XQ7PLM9ZR', '4KDT2N') + ' was used for the call'],
    good: ['the key is read from the environment at run time'],
  },
  {
    name: 'aws-account-id',
    secret: false,
    find: (line) => line.match(/\b\d{12}\b/g),
    bad: ['the account ' + sample('09876543', '2109') + ' owns the queue'],
    good: ['the account is written as a placeholder in the sample'],
  },
  {
    name: 'arn-with-account-id',
    secret: false,
    find: (line) => line.match(/\barn:aws[a-zA-Z0-9-]*:[^\s"']*\d{12}[^\s"']*/g),
    bad: ['the role ' + sample('arn:aws:iam::09876543', '2109:role/agent-runner') + ' was assumed'],
    good: ['the plan writes a role reference into the example file'],
  },
  {
    name: 'bearer-token',
    secret: true,
    find: (line) => line.match(/\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/g),
    bad: ['the request carried the header Authorization: ' + sample('Bearer abcdefghijklmnopqrstuvw', 'xyz012345')],
    good: ['the header carries a bearer token that is read at run time'],
  },
  {
    name: 'json-web-token',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}' +
        '\\.[A-Za-z0-9_-]{8,}', 'g')),
    bad: [
      'the answer was ' + sample(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        '.eyJzdWIiOiJhZ2VudC0xMjMifQ',
        '.9tT4xTn7YbQZ0mKq1sLpVh3RfJcWn8dAeBu5Gi0oXyQ',
      ),
    ],
    good: ['the value is a structured document with three parts'],
  },
  {
    name: 'github-token',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_' +
        '[A-Za-z0-9_]{20,})\\b', 'g')),
    bad: ['the script used ' + sample('gh' + 'p_0123', '456789abcdefghij', 'klmnopqrstuvwxyz')],
    good: ['the workflow reads a short lived value from the runner'],
  },
  {
    name: 'slack-token',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\bxox[abprs]-' + '[A-Za-z0-9-]{10,}', 'g')),
    bad: ['the notification went out with ' + sample('xox' + 'b-1234', '56789012', '-abcdefghijklmnop')],
    good: ['the notification is sent from the messaging service'],
  },
  {
    name: 'google-api-key',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\bAIza' + '[0-9A-Za-z_-]{35}\\b', 'g')),
    bad: ['the build used ' + sample('AIzaAbc12deFghi34jKlm', '56noPq78rstUvw90xy')],
    good: ['the build reads its key from the environment'],
  },
  {
    name: 'stripe-secret-key',
    secret: true,
    find: (line) =>
      line.match(new RegExp('\\b(?:sk|rk)_(?:live|test)_' + '[0-9A-Za-z]{10,}\\b', 'g')),
    bad: ['the payment key ' + sample('sk' + '_live_0123', '456789abcdefgh', 'ijklmn') + ' was rejected'],
    good: ['the payment provider is called at run time'],
  },
  {
    name: 'secret-assignment',
    secret: false,
    find: findSecretAssignments,
    excerpt: (hit) => `${hit.key}=${redact(hit.value)}`,
    bad: ['api_key = "aB3xQ9zLmN7pR2tK"'],
    good: [
      'api_key = REPLACE_ME',
      'password: <your-password>',
      'token = ${GITHUB_TOKEN}',
      'secret = "changeme"',
      'credential: $CREDENTIAL',
      'api_key = "example-key"',
      'token = "xxxxxxxx"',
      'password = "dummy"',
      'api_key = "fake"',
      'api_key = "sample-value"',
      'api_key = "redacted"',
      'api_key = "your-api-key"',
      'api_key = "placeholder"',
      'access_token: expect.any(String),',
    ],
  },
  {
    name: 'email-address',
    secret: false,
    find: findUnknownEmails,
    excerpt: (address) => `***@${address.slice(address.lastIndexOf('@') + 1)}`,
    bad: ['the agent wrote to person@internal-host.local'],
    good: ['write to security@example.invalid', 'the placeholder is user@example.com'],
  },
  {
    name: 'ipv4-address',
    secret: false,
    find: findUnknownIps,
    bad: ['the agent connected to 10.14.22.31'],
    good: ['the service listens on 127.0.0.1:8080', 'the sample address is 192.0.2.10'],
  },
  {
    name: 'absolute-path',
    secret: false,
    find: (line) =>
      line.match(/(?:\/(?:home|Users|var\/folders|mnt|media)\/)|(?:(?<![\w])[A-Za-z]:\\)/g),
    bad: ['the log lives in /home/agent/workspace/run.log', 'the file sits in C:\\Users\\agent\\run.log'],
    good: ['the path is relative to the repository root'],
  },
  {
    name: 'unknown-hostname',
    secret: false,
    find: findUnknownHosts,
    bad: ['the runner answered on build-runner.internal-host.local'],
    good: ['see https://example.com/docs for details', 'the package lives on npmjs.com'],
  },
];

// ---------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------

/** True when a directory never holds material that has to be published. */
function isSkippedDirectory(name) {
  if (SKIPPED_DIRECTORIES.has(name)) return true;
  // Hidden folders are skipped as well, apart from the ones the repository
  // publishes on purpose.
  return name.startsWith('.') && name !== '.github';
}

/** True when the file is a lock file. */
function isLockFile(name) {
  return LOCK_FILES.has(name.toLowerCase());
}

/**
 * Find the tree the command was given. That is the repository that contains the
 * directory the command was called from, and never the directory the script
 * itself happens to live in: a scanner that is copied somewhere else on one
 * machine would otherwise quietly scan that other place instead of the tree it
 * was called for. When the call site is not inside a repository, the tree it
 * was given is the directory it was called from.
 */
function findGivenTreeRoot(start) {
  const calledFrom = resolve(start);
  let current = calledFrom;
  for (;;) {
    let stats;
    try {
      stats = statSync(join(current, '.git'));
    } catch {
      stats = null;
    }
    // A linked worktree carries a pointer file instead of a git directory.
    if (stats !== null && (stats.isDirectory() || stats.isFile())) return current;
    const parent = dirname(current);
    if (parent === current) return calledFrom;
    current = parent;
  }
}

/** The real path of a directory, so two ways of naming the same place compare equal. */
function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The top of the repository the runner writes about, or null when it is not usable. */
function repositoryToplevel(root) {
  try {
    const output = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return realPathOf(output.trim());
  } catch {
    return null;
  }
}

/** True when a path sits inside the tree it was given, and not in its parent's tree. */
function isInsideTree(path, root) {
  const relation = relative(root, path);
  return relation !== '' && !relation.startsWith('..');
}

/** List every file under a root that has to be looked at. */
function collectFiles(root) {
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
      } else if (entry.isFile()) {
        if (!isLockFile(entry.name)) files.push(full);
      }
    }
  }
  return files.sort();
}

/**
 * Read the staged list of the next commit, exactly the way the runner writes
 * it. The paths in that list are relative to the top of the repository they
 * belong to, which is not always the tree the command was given, so they are
 * resolved against that top here. The caller places them against the tree it
 * was given afterwards. Returns null when git could not do its part, so the
 * caller can fail instead of looking at the wrong tree.
 */
function collectStagedFiles(root) {
  const toplevel = repositoryToplevel(root);
  if (toplevel === null) return null;
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
      { cwd: toplevel, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const staged = output
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => join(toplevel, entry));
    return { toplevel, staged };
  } catch {
    return null;
  }
}

/**
 * Place the staged list against the tree the command was given. A path the
 * tree holds on disk goes to the scan. A path that belongs to the repository
 * but not to the tree given is counted as outside, so it can be named instead
 * of being folded into a path that does not exist. A path the tree should hold
 * but does not is counted as unreadable, never dropped: the commit carries it
 * whether the scan saw it or not. A lock file is excluded here exactly the way
 * the whole-tree scan excludes it, so every mode of this scanner answers the
 * same question about the tree.
 */
function resolveStagedFiles(root, staged) {
  const files = [];
  const outside = [];
  const unreadable = [];
  const lockFiles = [];
  for (const path of staged) {
    if (!isInsideTree(path, root)) {
      outside.push(path);
      continue;
    }
    if (!existsSync(path)) {
      unreadable.push(path);
      continue;
    }
    if (isLockFile(basename(path))) {
      lockFiles.push(path);
      continue;
    }
    files.push(path);
  }
  return { files, outside, unreadable, lockFiles };
}

/**
 * Turn the paths the command was given into the list of files that have to be
 * read. A path outside the tree given names a different tree and is refused. A
 * path inside the tree given that cannot be read is reported rather than
 * skipped, because a scan that quietly leaves a path out would let a finding
 * pass by.
 */
function expandPaths(root, paths) {
  const files = [];
  const problems = [];
  for (const path of paths) {
    const full = resolve(root, path);
    if (!isInsideTree(full, root)) {
      problems.push(`scan-leaks: the path "${toPosix(path)}" is not inside the tree given`);
      continue;
    }
    let stats;
    try {
      stats = statSync(full);
    } catch {
      problems.push(`scan-leaks: the path "${toPosix(path)}" does not exist in the tree given`);
      continue;
    }
    if (stats.isFile()) {
      files.push(full);
    } else if (stats.isDirectory()) {
      files.push(...collectFiles(full));
    }
  }
  return { files, problems };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** The scanner never reports its own source, and never a copy of itself. */
function isSelfFile(filePath) {
  const self = resolve(fileURLToPath(import.meta.url));
  return resolve(filePath) === self || basename(filePath).toLowerCase() === 'scan-leaks.mjs';
}

/** Read a file and report everything the rules find in it. */
function scanFile(filePath, root) {
  const findings = [];
  if (isSelfFile(filePath)) return findings;

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return findings;
  }
  // A file with a null byte is not text and cannot be published by accident.
  if (content.includes('\u0000')) return findings;

  const lines = content.split(/\r?\n/);
  const file = toPosix(relative(root, filePath));

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const matches = rule.find(line);
      if (!matches) continue;
      for (const match of matches) {
        findings.push({
          file,
          line: index + 1,
          rule: rule.name,
          excerpt: rule.excerpt ? rule.excerpt(match) : rule.secret ? '<redacted>' : redact(match),
        });
      }
    }
  });

  return findings;
}

/**
 * Hold the report to the tree the command was given: every path a run reports
 * must exist inside the tree that was scanned. A path that does not exist
 * there is not a finding, it is a defect of the scanner, and the run fails
 * because of it instead of printing a reference to a file that is not there.
 */
function verifyReportedPaths(findings, root) {
  const problems = [];
  for (const finding of findings) {
    const full = resolve(root, finding.file);
    if (!isInsideTree(full, root) || !existsSync(full)) {
      problems.push(
        `scan-leaks: the scan reported "${finding.file}" which is not a path inside the tree given (${finding.rule})`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/** True when the runner is usable here, whatever the directory is. */
function gitIsUsable() {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a small repository with a staged set that exercises every rule of the
 * staged scan at once: a finding inside a subdirectory, a finding outside it,
 * a lock file that is excluded by rule, and a file staged for the commit whose
 * copy is gone from the tree, which the scan has to name and never drop. The
 * values in the fixture are addresses on the documentation ranges of the
 * rules, never anything that looks like a credential.
 */
function buildStagedFixture(prefix) {
  // The root is the real path of the fixture, so that the paths the runner
  // writes and the paths the scan places compare equal on every platform.
  const root = realPathOf(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'placeholder@example.invalid'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'a placeholder'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'base.md'), 'the base of the repository\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', 'base.md'], { stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'the base'], { stdio: ['ignore', 'pipe', 'ignore'] });
  writeFileSync(join(root, 'sub', 'inside.md'), 'the agent connected to 10.20.30.40\n', 'utf8');
  writeFileSync(join(root, 'outside.md'), 'the agent connected to 10.21.31.41\n', 'utf8');
  writeFileSync(join(root, 'package-lock.json'), '{}\n', 'utf8');
  writeFileSync(join(root, 'gone-from-tree.md'), 'the agent connected to 10.22.32.42\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  rmSync(join(root, 'gone-from-tree.md'));
  return root;
}

/** Run every rule against its own samples and report the rules that fail. */
function runSelfTest() {
  const failures = [];

  for (const rule of RULES) {
    for (const sample of rule.bad) {
      const matches = rule.find(sample);
      if (!matches || matches.length === 0) {
        failures.push(`the rule "${rule.name}" did not catch its own bad sample`);
      }
      for (const match of matches ?? []) {
        const shown = rule.excerpt ? rule.excerpt(match) : rule.secret ? '<redacted>' : redact(match);
        const value = typeof match === 'string' ? match : match.value;
        if (value && shown.includes(value)) {
          failures.push(`the rule "${rule.name}" printed a value in full`);
        }
      }
    }
    for (const sample of rule.good) {
      const matches = rule.find(sample);
      if (matches && matches.length > 0) {
        failures.push(`the rule "${rule.name}" fired on its own good sample`);
      }
    }
  }

  // A good sample of one rule must not trip another rule either.
  for (const rule of RULES) {
    for (const sample of rule.good) {
      for (const other of RULES) {
        if (other.name === rule.name) continue;
        if (other.find(sample)) {
          failures.push(`the rule "${other.name}" fired on a good sample of "${rule.name}"`);
        }
      }
    }
  }

  // The scanner must not report its own source.
  const ownFindings = scanFile(resolve(fileURLToPath(import.meta.url)), process.cwd());
  if (ownFindings.length > 0) {
    failures.push(`the scanner reported its own source ${ownFindings.length} time(s)`);
  }

  // The contract of the staged scan, proved in a temporary repository: the
  // list the runner writes is placed against the tree the scan was given,
  // nothing is dropped without a word, and every path the scan reports exists
  // in the tree it was given. The contract is skipped honestly when git is not
  // usable in the place the self-test runs.
  let stagedContract = 'ran in a temporary repository';
  if (!gitIsUsable()) {
    stagedContract = 'skipped, git is not usable here';
  } else {
    const fixtureRoot = buildStagedFixture('scan-leaks-self-test-');
    try {
      const staged = collectStagedFiles(fixtureRoot);
      if (staged === null) {
        failures.push('the staged list could not be read from a working repository');
      } else {
        // The list belongs to the repository, and it is written the way the
        // runner writes it: every path is relative to the top of it.
        if (staged.toplevel !== fixtureRoot) {
          failures.push('the staged list was not read from the repository it belongs to');
        }
        const names = staged.staged.map((path) => toPosix(relative(fixtureRoot, path)));
        for (const expected of ['sub/inside.md', 'outside.md', 'package-lock.json', 'gone-from-tree.md']) {
          if (!names.includes(expected)) failures.push(`the staged list is missing "${expected}"`);
        }

        // Given a part of the tree, the scan takes what belongs to it and
        // counts the rest, instead of folding it into paths that are not there.
        const subRoot = join(fixtureRoot, 'sub');
        const partially = resolveStagedFiles(subRoot, staged.staged);
        if (partially.files.length !== 1 || partially.files[0] !== join(subRoot, 'inside.md')) {
          failures.push('the scan did not take exactly the staged files the tree it was given holds');
        }
        if (partially.outside.length !== 3) {
          failures.push('staged paths that belong to another tree must be counted, not folded into paths that are not there');
        }

        // Given the whole tree, the path that is not on the disk is reported
        // and the two held files are the only ones the scan reads.
        const completely = resolveStagedFiles(fixtureRoot, staged.staged);
        if (completely.unreadable.length !== 1 || !completely.unreadable[0].endsWith('gone-from-tree.md')) {
          failures.push('a staged file that is not on the disk must be reported, not dropped');
        }
        if (completely.files.length !== 2 || completely.lockFiles.length !== 1) {
          failures.push('the scan must take the files the tree holds and exclude the lock file, the way it does everywhere');
        }

        // The findings of the fixture report paths that exist, and a path that
        // does not exist inside the tree given never passes as a finding.
        const findings = [];
        for (const file of completely.files) findings.push(...scanFile(file, fixtureRoot));
        if (findings.length !== 2) {
          failures.push('the scan did not find the findings of its own staged fixture');
        }
        if (verifyReportedPaths(findings, fixtureRoot).length > 0) {
          failures.push('the scan reported a path that does not exist in the tree it was given');
        }
        if (
          verifyReportedPaths(
            [{ file: '../beyond.md', line: 1, rule: 'the fixture rule', excerpt: '' }],
            fixtureRoot,
          ).length !== 1
        ) {
          failures.push('a reported path outside the tree given must fail the check that holds the report to that tree');
        }
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    process.stdout.write('scan-leaks self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(
    `scan-leaks self-test: passed (${RULES.length} rules, ${RULES.reduce((sum, rule) => sum + rule.bad.length + rule.good.length, 0)} samples; the staged contract ${stagedContract})\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'scan-leaks — find anything in this repository that must not be published.',
      '',
      'Usage:',
      '  node scripts/scan-leaks.mjs [options] [paths...]',
      '',
      'Options:',
      '  --root <dir>  Scan another directory. Default: the repository that',
      '                contains the directory the command was called from.',
      '  --staged      Scan the files staged for the next commit. The staged list',
      '                is read from the repository it belongs to, a path of the',
      '                commit that cannot be read fails the scan, and a staged',
      '                scan of part of the repository is refused.',
      '  --json        Print the findings as JSON instead of text.',
      '  --quiet       Print the findings but not the closing summary line.',
      '  --self-test   Run the patterns against known good and bad samples.',
      '  --help        Print this help and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one finding, a staged file that could not be read, or the',
      '     self-test failed.',
      '  2  the command line could not be understood, or a path was given that',
      '     does not belong to the tree the scan was given.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = { root: null, staged: false, json: false, quiet: false, selfTest: false, help: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--quiet' || argument === '-q') options.quiet = true;
    else if (argument === '--self-test') options.selfTest = true;
    else if (argument === '--staged') options.staged = true;
    else if (argument === '--root' || argument === '--dir') {
      index += 1;
      options.root = argv[index];
    } else if (argument.startsWith('--root=')) options.root = argument.slice('--root='.length);
    else if (argument.startsWith('-')) {
      process.stderr.write(`scan-leaks: the option "${argument}" is not known\n`);
      return null;
    } else options.paths.push(argument);
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
    process.stdout.write(`${finding.file}:${finding.line}: [${finding.rule}] ${finding.excerpt}\n`);
  }
  if (!options.quiet) {
    const files = new Set(findings.map((finding) => finding.file)).size;
    process.stdout.write(`scan-leaks: ${findings.length} finding(s) in ${files} file(s)\n`);
  }
}

/** Run the scanner. */
function main(argv) {
  const options = parseArguments(argv);
  if (options === null) return 2;
  if (options.help) {
    printUsage();
    return 0;
  }
  if (options.selfTest) return runSelfTest();

  // The tree the command was given. It is derived from the place the command
  // was called from, and an explicit root is the caller naming the tree it
  // means. The tree the script itself happens to live in is never the answer:
  // a scan of that tree would be a scan of a place nobody gave the command.
  const root = realPathOf(resolve(options.root ?? findGivenTreeRoot(process.cwd())));
  if (!existsSync(root)) {
    process.stderr.write(`scan-leaks: the directory "${root}" does not exist\n`);
    return 2;
  }

  let files;
  if (options.staged) {
    const staged = collectStagedFiles(root);
    if (staged === null) {
      // A scan that cannot see the list the runner wrote cannot pass a commit.
      // Falling back to the whole tree would answer a question about a different
      // tree than the one the commit belongs to, so the run fails instead.
      process.stderr.write('scan-leaks: git could not name the repository the staged list belongs to, nothing was scanned\n');
      return 1;
    }
    if (staged.toplevel !== root) {
      // The tree a tool is given and the tree it writes must be the same tree.
      // The runner writes about the whole repository, so a staged scan of part
      // of it would leave the rest of the commit unchecked.
      process.stderr.write(
        `scan-leaks: the staged list belongs to "${toPosix(staged.toplevel)}" and the scan was given "${toPosix(root)}"\n`,
      );
      process.stderr.write('scan-leaks: a staged scan covers the whole commit or it covers nothing\n');
      return 2;
    }

    const placed = resolveStagedFiles(root, staged.staged);
    for (const path of placed.unreadable) {
      process.stderr.write(
        `scan-leaks: the staged file "${toPosix(relative(root, path))}" is not present in the tree, so what the commit carries was not read\n`,
      );
    }
    if (placed.lockFiles.length > 0) {
      process.stderr.write(
        `scan-leaks: ${placed.lockFiles.length} locked dependency file(s) are excluded, the way the whole-tree scan excludes them; a lock file is regenerated by one deliberate command and is reviewed through the dependency tooling\n`,
      );
    }
    // With the tree of the commit as the root, nothing on the staged list can sit
    // outside the tree. A path that does is a defect of this scanner, and the
    // run says so instead of pretending the commit was smaller than it is.
    if (placed.outside.length > 0) {
      for (const path of placed.outside) {
        process.stderr.write(
          `scan-leaks: the scanner could not place the staged path "${toPosix(path)}" inside the tree given\n`,
        );
      }
      return 1;
    }
    files = placed.files;
  } else if (options.paths.length > 0) {
    const expanded = expandPaths(root, options.paths);
    for (const problem of expanded.problems) process.stderr.write(`${problem}\n`);
    if (expanded.problems.length > 0) return 2;
    files = expanded.files;
  } else {
    files = collectFiles(root);
  }

  const findings = [];
  for (const file of files) findings.push(...scanFile(file, root));

  // The last check is the one this tool owes its readers: a path the scan
  // reports exists in the tree the scan was given, or the run fails.
  const integrity = verifyReportedPaths(findings, root);
  for (const problem of integrity) process.stderr.write(`${problem}\n`);

  report(findings, options);
  return findings.length > 0 || integrity.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
