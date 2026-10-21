#!/usr/bin/env node
/**
 * scan-leaks.mjs — a leak scanner for this repository.
 *
 * The scanner walks the working tree and reports anything that looks like a
 * credential, a real identifier, or a path that belongs to one machine. It uses
 * nothing but the Node standard library, it runs the same way on Linux, macOS
 * and Windows, and it needs no installation step.
 *
 * Usage:
 *   node scripts/scan-leaks.mjs [options] [paths...]
 *
 * Options:
 *   --root <dir>  Scan another directory. Default: the repository root.
 *   --staged      Scan only the files that are staged for the next commit.
 *   --json        Print the findings as JSON instead of text.
 *   --quiet       Print the findings but not the closing summary line.
 *   --self-test   Run the patterns against known good and bad samples.
 *   --help        Print this help and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one finding, or the self-test failed.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** List the files that are staged for the next commit, or null when git is not usable. */
function collectStagedFiles(root) {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => join(root, entry))
      .filter((entry) => existsSync(entry));
  } catch {
    return null;
  }
}

/** Turn a list of paths into the list of files that have to be read. */
function expandPaths(root, paths) {
  const files = [];
  for (const path of paths) {
    const full = resolve(root, path);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isFile()) {
      files.push(full);
    } else if (stats.isDirectory()) {
      files.push(...collectFiles(full));
    }
  }
  return files;
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

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

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

  if (failures.length > 0) {
    process.stdout.write('scan-leaks self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(
    `scan-leaks self-test: passed (${RULES.length} rules, ${RULES.reduce((sum, rule) => sum + rule.bad.length + rule.good.length, 0)} samples)\n`,
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
      '  --root <dir>  Scan another directory. Default: the repository root.',
      '  --staged      Scan only the files that are staged for the next commit.',
      '  --json        Print the findings as JSON instead of text.',
      '  --quiet       Print the findings but not the closing summary line.',
      '  --self-test   Run the patterns against known good and bad samples.',
      '  --help        Print this help and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one finding, or the self-test failed.',
      '  2  the command line could not be understood.',
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

  const root = resolve(options.root ?? resolve(fileURLToPath(import.meta.url), '..', '..'));
  if (!existsSync(root)) {
    process.stderr.write(`scan-leaks: the directory "${root}" does not exist\n`);
    return 2;
  }

  let files;
  if (options.staged) {
    const staged = collectStagedFiles(root);
    if (staged === null) {
      process.stderr.write('scan-leaks: git could not list the staged files, the whole tree is scanned\n');
      files = collectFiles(root);
    } else {
      files = staged;
    }
  } else if (options.paths.length > 0) {
    files = expandPaths(root, options.paths);
  } else {
    files = collectFiles(root);
  }

  const findings = [];
  for (const file of files) findings.push(...scanFile(file, root));

  report(findings, options);
  return findings.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
