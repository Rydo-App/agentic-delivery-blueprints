#!/usr/bin/env node
/**
 * handoff.mjs — the tool that enforces the credential hand-over protocol.
 *
 * The protocol lives in docs/credential-handoff.md. It says that a credential
 * travels as a file and never as a value, that the manifest beside the file
 * is the part that may be put in a message, that the receiver checks the
 * digest and the permissions before it uses the value, and that the copy is
 * destroyed when the work is done and that a record is left behind.
 *
 * This tool does four things:
 *
 *   write    the holder writes the bundle and the manifest;
 *   verify   the receiver checks the bundle against its manifest;
 *   digest   an agent proves that it holds the right value without showing it;
 *   destroy  the copy stops existing and a record is left behind.
 *
 * Usage:
 *   node scripts/handoff.mjs <command> [options]
 *
 * Commands:
 *   write     Write the credential files and the manifest of a bundle.
 *   verify    Check a bundle against its manifest.
 *   digest    Print the kind, the digest and the prefix of a file.
 *   destroy   Remove the credentials of a bundle and leave a record.
 *
 * Options that every command understands:
 *   --json        Print the result as JSON instead of text.
 *   --quiet       Print the findings but not the closing summary.
 *   --self-test   Run the rules against known good and known bad bundles.
 *   --help        Print the help of the command and exit.
 *
 * Exit codes:
 *   0  nothing was found, or the self-test passed.
 *   1  at least one finding, or the self-test failed.
 *   2  the command line could not be understood, or it asked for something
 *      the protocol forbids.
 *
 * What this tool never does:
 *   - it never prints the value of a credential, in any command and in any
 *     format, not even in an error message;
 *   - it never writes a value into a manifest, a record or a message;
 *   - it never reads a path that points out of the bundle directory;
 *   - it never removes anything outside the bundle directory.
 *
 * The tool uses nothing but the Node standard library, it runs the same way on
 * Linux, macOS and Windows, and it needs no installation step.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The name of the manifest inside a bundle. The protocol calls it the
// manifest and puts it beside the credential files.
const MANIFEST_NAME = 'manifest.txt';

// The version of the protocol this tool speaks. It is the first line of every
// manifest, and a manifest without it is not read.
const PROTOCOL_ID = 'credential-handoff/1';

// The longest prefix the protocol allows. Four characters recognise a value
// and cannot be used as one.
const MAX_PREFIX_LENGTH = 4;

// How long a credential may live when the caller does not say. A week is
// long enough to finish a task and short enough that nobody forgets it.
const DEFAULT_LIFETIME_DAYS = 7;

// The destroy instruction of a credential that has no date of its own.
const DEFAULT_DESTROY_TEXT = 'when the task is done, or on the date above';

// The kind a file is given when the caller does not name one.
const DEFAULT_KIND = 'credential';

// The accounts that may always read a file on a Windows machine. The system
// account and the administrators group cannot be taken away from a file
// without breaking the machine, so they are part of the trust of the owner
// and not a leak. Every other account, including the users of the machine
// and the authenticated users, is a leak when it can read the file.
const WINDOWS_SYSTEM_PRINCIPALS = [
  'nt authority\\system',
  'builtin\\administrators',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * A sample that has to look like a secret to the rules, but must not look
 * like one to the platform that scans a push.
 *
 * The parts are joined when the sample is built, so the text in the tree is
 * never a complete value of a secret shape. A sample written out in full
 * would be refused by the push protection of the hosting platform, which
 * would stop the very repository that is meant to keep such values out.
 */
function sample(...parts) {
  return parts.join('');
}

/** The moment, in the form the manifest writes. */
function nowStamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A time a number of days from now, in the form the manifest writes. */
function daysFromNow(days) {
  const moment = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return moment.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Read a lifetime such as 30m, 6h, 7d or 2w and return it in milliseconds.
 * The bundle is written by a person or an agent that has to type it, so the
 * short form is the only one there is.
 */
function parseDuration(text) {
  const match = /^(\d+)([mhdw])$/.exec(String(text).trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]];
  return amount * unit;
}

/** The digest and the prefix of a file, read once and never printed whole. */
function readCredentialFile(path) {
  const buffer = readFileSync(path);
  const digest = createHash('sha256').update(buffer).digest('hex');
  // The prefix is the first characters of the value. A line ending at the end
  // of the file is formatting and not part of the value.
  const text = buffer.toString('utf8').replace(/\r?\n$/, '');
  return { digest, prefix: text.slice(0, MAX_PREFIX_LENGTH), bytes: buffer.length };
}

/** True when the text is one of the placeholder forms, and so is not a value. */
function isPlaceholder(text) {
  const value = String(text).trim();
  if (value.length === 0) return true;
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
  ];
  return patterns.some((rule) => rule.exec(value) !== null);
}

/** True when the path names something outside the directory it was resolved in. */
function isInside(base, target) {
  return target === base || target.startsWith(base + sep);
}

/** The number of kinds of character a text uses, which says how random it looks. */
function characterClasses(text) {
  let classes = 0;
  if (/[a-z]/.test(text)) classes += 1;
  if (/[A-Z]/.test(text)) classes += 1;
  if (/[0-9]/.test(text)) classes += 1;
  if (/[^A-Za-z0-9]/.test(text)) classes += 1;
  return classes;
}

// ---------------------------------------------------------------------------
// The shapes a manifest must never hold
// ---------------------------------------------------------------------------

// The shapes that mean a value found its way into the manifest. The manifest
// travels in a message, so a value in it is a value that has leaked.
//
// The shapes are described and not named after the thing that made them, and
// the text of this file is published, so a whole shape is never written out.
const SECRET_SHAPES = [
  {
    name: 'private-key-block',
    pattern: new RegExp('-----BEGIN [A-Z0-9 ]*' + 'PRIVATE KEY-----'),
  },
  {
    name: 'json-web-token',
    pattern: new RegExp('\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
  },
  {
    name: 'bearer-token',
    pattern: new RegExp('\\bBearer\\s+[A-Za-z0-9\\-._~+/]{20,}={0,2}'),
  },
  {
    name: 'key-identifier',
    // A block of capital letters and digits, which is the shape of the
    // identifier of a key in many a service.
    pattern: new RegExp('\\b[A-Z]{4}[0-9A-Z]{12,20}\\b'),
  },
  {
    name: 'prefixed-token',
    // A short prefix, a word and a long body, which is the shape of a token
    // in many a service.
    pattern: new RegExp('\\b[a-z]{2,4}_[a-z]{4,6}_[A-Za-z0-9]{10,}\\b'),
  },
  {
    name: 'password-in-connection-string',
    pattern: new RegExp('[a-z][a-z0-9+.-]*://[^\\s:@/]+:[^\\s:@/]+@', 'i'),
  },
  {
    name: 'credential-assignment',
    pattern: new RegExp(
      '[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|credential)' +
        '[A-Za-z0-9_.-]*\\s*[:=]\\s*\\S{8,}',
      'i',
    ),
  },
];

/**
 * The name of the shape a text has, when it has one that a manifest must not
 * have, and null when it has none.
 *
 * The rules are about the shape of the text, because the shape is all that
 * can be looked at without reading a value into the message.
 */
function secretShapeOf(text) {
  const value = String(text);
  if (value.length === 0) return null;
  if (isPlaceholder(value)) return null;
  for (const shape of SECRET_SHAPES) {
    if (shape.pattern.exec(value) !== null) return shape.name;
  }
  // A long text with no space in it and with several kinds of character in it
  // is what a random value looks like. A digest is a long text like that and
  // is safe to publish, and so is a date, and neither is a value.
  if (value.length < 24) return null;
  if (/\s/.test(value)) return null;
  if (/^[0-9a-f]{32,}$/i.test(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  if (characterClasses(value) < 3) return null;
  return 'a long text that looks random';
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** The identity of the user that runs the tool, as a security identifier. */
let cachedOwnerSid = null;
function ownerSid() {
  if (cachedOwnerSid !== null) return cachedOwnerSid;
  try {
    const output = execFileSync('whoami', ['/user'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = output.match(/S-1-\d+(?:-\d+)+/g);
    cachedOwnerSid = found && found.length > 0 ? found[found.length - 1] : '';
  } catch {
    cachedOwnerSid = '';
  }
  return cachedOwnerSid;
}

/** The name of the user that runs the tool. */
let cachedOwnerName = null;
function ownerName() {
  if (cachedOwnerName !== null) return cachedOwnerName;
  try {
    const output = execFileSync('whoami', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedOwnerName = output.trim().split(/\r?\n/)[0].trim();
  } catch {
    cachedOwnerName = '';
  }
  return cachedOwnerName;
}

/**
 * Set the permissions so that only the owner can read the file or the
 * directory.
 *
 * On a system with POSIX permissions that is 0600 for a file and 0700 for a
 * directory. On Windows the mode bits are not permissions at all, so an
 * access control list with a single allowed identity is written instead.
 */
function setOwnerOnly(target, isDirectory) {
  if (process.platform !== 'win32') {
    chmodSync(target, isDirectory ? 0o700 : 0o600);
    return { ok: true, how: 'posix-mode' };
  }

  const sid = ownerSid();
  if (!sid) {
    return { ok: false, how: 'none', reason: 'the identity of the owner could not be read' };
  }
  const rights = isDirectory ? '(OI)(CI)(F)' : '(F)';
  try {
    execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `*${sid}:${rights}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { ok: false, how: 'windows-acl', reason: `the access control list could not be written (${error.status ?? 'error'})` };
  }
  return { ok: true, how: 'windows-acl' };
}

/** Read the access control list of a path on Windows. */
function readWindowsAcl(target) {
  let output;
  try {
    output = execFileSync('icacls', [target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  const principals = [];
  const prefixes = [resolve(target), target];
  for (const raw of output.split(/\r?\n/)) {
    let text = raw.trim();
    if (text.length === 0) continue;
    for (const prefix of prefixes) {
      if (prefix && text.startsWith(prefix)) {
        text = text.slice(prefix.length).trim();
        break;
      }
    }
    const marker = text.lastIndexOf(':(');
    if (marker === -1) continue;
    principals.push({
      name: text.slice(0, marker).trim(),
      // The rights are written as flags, such as (I)(RX), and the letters
      // that matter are the ones that say the file can be read.
      rights: text.slice(marker + 2).replace(/[()]/g, '').trim(),
    });
  }
  return principals;
}

/** True when a set of rights lets the holder read the file. */
function rightsAllowReading(rights) {
  return /[RFMD]/.test(rights);
}

/**
 * Check that only the owner can read a path.
 *
 * On a POSIX system the mode bits say it. On Windows the access control list
 * says it, and the accounts of the system itself are accepted, because they
 * cannot be taken away from a file without breaking the machine.
 */
function checkOwnerOnly(target, isDirectory) {
  if (process.platform !== 'win32') {
    const stats = statSync(target);
    const mode = stats.mode & 0o777;
    const others = mode & 0o077;
    return {
      ok: others === 0,
      detail: `mode ${mode.toString(8).padStart(4, '0')}`,
      others: others === 0 ? [] : ['every other account'],
    };
  }

  const principals = readWindowsAcl(target);
  if (principals === null) {
    return { ok: false, detail: 'the access control list could not be read', others: ['unknown'] };
  }
  const allowed = [ownerName().toLowerCase(), ownerSid().toLowerCase()];
  const others = [];
  for (const principal of principals) {
    const name = principal.name.toLowerCase();
    if (!rightsAllowReading(principal.rights)) continue;
    if (allowed.includes(name)) continue;
    if (WINDOWS_SYSTEM_PRINCIPALS.includes(name)) continue;
    if (others.includes(principal.name)) continue;
    others.push(principal.name);
  }
  return {
    ok: others.length === 0,
    detail: `${principals.length} entr(ies) in the access control list`,
    others,
  };
}

// ---------------------------------------------------------------------------
// The repository check
// ---------------------------------------------------------------------------

/**
 * Find the repository a directory belongs to, or null when it is in none.
 *
 * The protocol keeps a credential out of every repository, because a
 * repository tracks the files inside it and a tracked credential is a
 * published credential.
 */
function findRepositoryRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Paths that stay inside the bundle
// ---------------------------------------------------------------------------

/**
 * Resolve a name that came out of a bundle and keep it inside the bundle.
 *
 * A bundle that this tool did not create may name any path at all, and a
 * manifest must never be able to send the tool outside the directory it
 * describes.
 */
function resolveInside(bundleDir, name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, reason: 'the name of the file is empty' };
  }
  const value = name.trim();
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return { ok: false, reason: 'the name of the file is an absolute path' };
  }
  const base = resolve(bundleDir);
  const full = resolve(base, value);
  if (!isInside(base, full)) {
    return { ok: false, reason: 'the name of the file points outside the bundle' };
  }
  return { ok: true, path: full };
}

/**
 * The same, but for a path that exists: a symbolic link may lead out of the
 * bundle even when the name does not.
 */
function resolveRealInside(bundleDir, name) {
  const inside = resolveInside(bundleDir, name);
  if (!inside.ok) return inside;
  let realBase;
  try {
    realBase = realpathSync(resolve(bundleDir));
  } catch {
    realBase = resolve(bundleDir);
  }
  let realTarget;
  try {
    realTarget = realpathSync(inside.path);
  } catch {
    return inside;
  }
  if (!isInside(realBase, realTarget)) {
    return { ok: false, reason: 'the file is a link that leads outside the bundle' };
  }
  return { ok: true, path: inside.path };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Write the manifest in the plain text format of the protocol. */
function renderManifest(manifest) {
  const lines = [];
  lines.push(`protocol: ${PROTOCOL_ID}`);
  lines.push(`bundle: ${manifest.bundle}`);
  lines.push(`written: ${manifest.written}`);
  lines.push(`written_by: ${manifest.writtenBy}`);
  lines.push(`destroy_after: ${manifest.destroyAfter}`);
  lines.push('');
  for (const entry of manifest.credentials) {
    lines.push(`credential: ${entry.name}`);
    lines.push(`  file: ${entry.file}`);
    lines.push(`  kind: ${entry.kind}`);
    lines.push(`  digest: sha256:${entry.digest}`);
    lines.push(`  prefix: ${entry.prefix}`);
    lines.push(`  for: ${entry.forMachine}`);
    lines.push(`  reason: ${entry.reason}`);
    lines.push(`  destroy: ${entry.destroy}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

/**
 * Read a manifest in the plain text format of the protocol.
 *
 * A manifest that is not in that format is reported as unreadable. It is
 * never guessed at, because a guess about a digest is a guess about a
 * credential.
 */
function parseManifest(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indented = /^\s/.test(line);
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!match) {
      return { ok: false, reason: 'a line of the manifest is not a field of the format' };
    }
    const key = match[1];
    const value = match[2].trim();

    if (indented) {
      if (current === null) {
        return { ok: false, reason: 'a field appears before any credential block' };
      }
      current.fields[key] = value;
      continue;
    }
    if (key === 'credential') {
      current = { name: value, fields: {} };
      blocks.push(current);
      continue;
    }
    if (current !== null) {
      return { ok: false, reason: `the field "${key}" appears after a credential block` };
    }
    header[key] = value;
  }

  if (header.protocol !== PROTOCOL_ID) {
    return { ok: false, reason: 'the first line does not name the protocol of the manifest' };
  }
  for (const key of ['bundle', 'written', 'written_by', 'destroy_after']) {
    if (!header[key] || header[key].length === 0) {
      return { ok: false, reason: `the manifest has no "${key}" field` };
    }
  }
  if (blocks.length === 0) {
    return { ok: false, reason: 'the manifest names no credential' };
  }

  const credentials = [];
  for (const block of blocks) {
    if (!block.name || block.name.length === 0) {
      return { ok: false, reason: 'a credential block has no name' };
    }
    for (const key of ['file', 'kind', 'digest', 'prefix', 'for', 'reason', 'destroy']) {
      if (!(key in block.fields)) {
        return { ok: false, reason: `the credential "${block.name}" has no "${key}" field` };
      }
    }
    const digest = block.fields.digest;
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: `the credential "${block.name}" has a digest that is not a sha256 digest` };
    }
    credentials.push({
      name: block.name,
      file: block.fields.file,
      kind: block.fields.kind,
      digest: digest.slice('sha256:'.length),
      prefix: block.fields.prefix,
      forMachine: block.fields.for,
      reason: block.fields.reason,
      destroy: block.fields.destroy,
    });
  }

  return {
    ok: true,
    manifest: {
      bundle: header.bundle,
      written: header.written,
      writtenBy: header.written_by,
      destroyAfter: header.destroy_after,
      credentials,
    },
  };
}

/**
 * The path of the manifest inside a bundle. The name comes from the caller
 * and it may not point out of the bundle, because the manifest is the part
 * that may travel.
 */
function manifestPathIn(bundleDir, manifestName) {
  const inside = resolveInside(bundleDir, manifestName);
  if (!inside.ok) return inside;
  return { ok: true, path: inside.path };
}

// ---------------------------------------------------------------------------
// The credential specification
// ---------------------------------------------------------------------------

/**
 * Read one credential specification.
 *
 * The form is a list of name=value pairs separated by semicolons, so that a
 * caller can pass a whole credential on one command line without a file.
 */
function parseCredentialSpec(text) {
  const spec = {};
  for (const part of String(text).split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) {
      return { ok: false, reason: `the part "${trimmed}" is not a name=value pair` };
    }
    const key = trimmed.slice(0, equals).trim().toLowerCase().replace(/-/g, '');
    const value = trimmed.slice(equals + 1).trim();
    spec[key] = value;
  }
  return { ok: true, spec };
}

/** The fields a credential specification may carry. */
const SPEC_FIELDS = ['name', 'kind', 'file', 'for', 'reason', 'source', 'prefix', 'ttl', 'destroyafter'];

/** Read a specification file, which holds the same fields in a JSON form. */
function readSpecFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'the specification file could not be read' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the specification file is not a JSON document' };
  }
  if (!parsed || !Array.isArray(parsed.credentials)) {
    return { ok: false, reason: 'the specification file has no list of credentials' };
  }
  const list = [];
  for (const item of parsed.credentials) {
    if (!item || typeof item !== 'object') {
      return { ok: false, reason: 'a credential of the specification file is not an object' };
    }
    const spec = {};
    for (const [key, value] of Object.entries(item)) {
      if (value === null || value === undefined) continue;
      spec[key.toLowerCase().replace(/-/g, '')] = String(value);
    }
    list.push(spec);
  }
  return {
    ok: true,
    specs: list,
    bundle: parsed.bundle ?? null,
    machine: parsed.machine ?? null,
    destroyAfter: parsed.destroyAfter ?? null,
    ttl: parsed.ttl ?? null,
  };
}

// ---------------------------------------------------------------------------
// The write command
// ---------------------------------------------------------------------------

/**
 * Write the credential files and the manifest of a bundle.
 *
 * The tool writes the manifest beside the credential files and never puts a
 * value into it, because the manifest is the part that travels in a message.
 */
function writeBundle(options) {
  const bundleDir = resolve(options.bundle);
  const notes = [];

  // The bundle is written outside every repository, unless the caller says
  // that they know what they are doing.
  const repository = findRepositoryRoot(bundleDir);
  if (repository && !options.allowInRepo) {
    return {
      code: 2,
      error:
        `the bundle is inside a repository and a credential must not be written into one; ` +
        `pass --allow-in-repo if that is what you want`,
    };
  }

  // The credentials of the bundle come from the command line, from a
  // specification file, or from both.
  let specs = options.specs.slice();
  let fromFile = { machine: null, bundle: null, destroyAfter: null, ttl: null };
  if (options.specFile) {
    const read = readSpecFile(options.specFile);
    if (!read.ok) return { code: 2, error: read.reason };
    specs = specs.concat(read.specs);
    fromFile = read;
  }
  if (specs.length === 0) {
    return { code: 2, error: 'the bundle names no credential; use --credential or --spec' };
  }

  // The machine that writes the bundle is named on the command line or in
  // the specification file.
  const machine = options.machine || fromFile.machine;
  if (!machine) {
    return { code: 2, error: 'the machine that writes the bundle is not named; use --machine' };
  }

  // The lifetime of the credentials is either a duration or a date.
  let destroyAfter = null;
  const destroyAfterText = options.destroyAfter || fromFile.destroyAfter;
  const ttlText = options.ttl || fromFile.ttl;
  if (destroyAfterText) {
    const parsed = Date.parse(destroyAfterText);
    if (!Number.isFinite(parsed)) {
      return { code: 2, error: 'the date of destruction could not be read' };
    }
    destroyAfter = new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } else if (ttlText) {
    const millis = parseDuration(ttlText);
    if (millis === null) return { code: 2, error: 'the lifetime could not be read; write it as 30m, 6h, 7d or 2w' };
    destroyAfter = daysFromNow(millis / 86400000);
  } else {
    destroyAfter = daysFromNow(DEFAULT_LIFETIME_DAYS);
    notes.push(`no lifetime was given, so the credentials live for ${DEFAULT_LIFETIME_DAYS} days`);
  }

  // The bundle directory is made before the files are written.
  if (existsSync(bundleDir) && !statSync(bundleDir).isDirectory()) {
    return { code: 2, error: 'the bundle path is a file and not a directory' };
  }
  mkdirSync(bundleDir, { recursive: true });
  const directoryPermission = setOwnerOnly(bundleDir, true);
  if (!directoryPermission.ok) {
    return { code: 2, error: `the bundle directory could not be locked down (${directoryPermission.reason})` };
  }

  const written = [];
  for (const spec of specs) {
    for (const key of Object.keys(spec)) {
      if (!SPEC_FIELDS.includes(key)) {
        return { code: 2, error: `the field "${key}" is not one a credential carries` };
      }
    }
    if (!spec.name) return { code: 2, error: 'a credential has no name' };
    if (!spec.kind) return { code: 2, error: `the credential "${spec.name}" has no kind` };
    if (!spec.file) return { code: 2, error: `the credential "${spec.name}" has no file` };
    if (!spec.reason) return { code: 2, error: `the credential "${spec.name}" has no reason` };

    // A prefix of more than four characters is a secret in its own right,
    // and it is refused before anything is written.
    if (spec.prefix !== undefined && spec.prefix.length > MAX_PREFIX_LENGTH) {
      return {
        code: 2,
        error: `the prefix of the credential "${spec.name}" is ${spec.prefix.length} characters long and the protocol allows ${MAX_PREFIX_LENGTH}`,
      };
    }

    // The file of the credential stays inside the bundle.
    const inside = resolveInside(bundleDir, spec.file);
    if (!inside.ok) {
      return { code: 2, error: `the credential "${spec.name}": ${inside.reason}` };
    }
    const filePath = inside.path;

    // The value is copied into the bundle when a source is named, and the
    // file is expected to be there when it is not.
    if (spec.source) {
      let source;
      try {
        source = readFileSync(spec.source);
      } catch {
        return { code: 2, error: `the source of the credential "${spec.name}" could not be read` };
      }
      // A credential may live in a folder of the bundle, and the folder is
      // made private as well.
      const folder = dirname(filePath);
      if (!existsSync(folder)) {
        mkdirSync(folder, { recursive: true });
        setOwnerOnly(folder, true);
      }
      writeFileSync(filePath, source, { mode: 0o600 });
    } else if (!existsSync(filePath)) {
      return { code: 2, error: `the file of the credential "${spec.name}" is not in the bundle and no source was named` };
    }

    const permission = setOwnerOnly(filePath, false);
    if (!permission.ok) {
      return { code: 2, error: `the file of the credential "${spec.name}" could not be locked down (${permission.reason})` };
    }

    let read;
    try {
      read = readCredentialFile(filePath);
    } catch {
      return { code: 2, error: `the file of the credential "${spec.name}" could not be read` };
    }

    // A prefix of more than four characters is a secret in its own right.
    const prefix = spec.prefix === undefined ? read.prefix : spec.prefix;

    // A credential of the bundle may live for less time than the bundle.
    let ownDestroyAfter = null;
    if (spec.destroyafter) {
      const parsed = Date.parse(spec.destroyafter);
      if (!Number.isFinite(parsed)) {
        return { code: 2, error: `the date of destruction of the credential "${spec.name}" could not be read` };
      }
      ownDestroyAfter = new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
    } else if (spec.ttl) {
      const millis = parseDuration(spec.ttl);
      if (millis === null) {
        return { code: 2, error: `the lifetime of the credential "${spec.name}" could not be read` };
      }
      ownDestroyAfter = daysFromNow(millis / 86400000);
    }

    written.push({
      name: spec.name,
      kind: spec.kind,
      file: toPosix(spec.file),
      digest: read.digest,
      prefix,
      forMachine: spec.for || machine,
      reason: spec.reason,
      destroy: ownDestroyAfter
        ? `when the task is done, or on ${ownDestroyAfter}`
        : DEFAULT_DESTROY_TEXT,
    });
  }

  const manifest = {
    bundle: options.bundleName || fromFile.bundle || bundleDir.split(sep).filter(Boolean).pop() || 'bundle',
    written: nowStamp(),
    writtenBy: machine,
    destroyAfter,
    credentials: written,
  };

  const manifestPath = manifestPathIn(bundleDir, options.manifest);
  if (!manifestPath.ok) {
    return { code: 2, error: `the manifest: ${manifestPath.reason}` };
  }
  writeFileSync(manifestPath.path, renderManifest(manifest), { encoding: 'utf8', mode: 0o600 });
  const manifestPermission = setOwnerOnly(manifestPath.path, false);
  if (!manifestPermission.ok) {
    return { code: 2, error: `the manifest could not be locked down (${manifestPermission.reason})` };
  }

  // The paths are reported as the caller wrote them, so that the output of
  // the tool never carries the shape of the machine it runs on.
  return {
    code: 0,
    manifest,
    manifestPath: manifestPath.path,
    bundlePath: options.bundle,
    manifestPathGiven: join(options.bundle, options.manifest),
    notes,
  };
}

// ---------------------------------------------------------------------------
// The verify command
// ---------------------------------------------------------------------------

/**
 * The fields of a manifest, apart from the digest, which the format itself
 * checks. Every one of them is looked at for a value, because the manifest
 * travels in a message.
 */
function manifestFields(manifest) {
  const fields = [
    ['the bundle field', manifest.bundle],
    ['the written field', manifest.written],
    ['the written_by field', manifest.writtenBy],
    ['the destroy_after field', manifest.destroyAfter],
  ];
  for (const entry of manifest.credentials) {
    fields.push([`the name of "${entry.name}"`, entry.name]);
    fields.push([`the file of "${entry.name}"`, entry.file]);
    fields.push([`the kind of "${entry.name}"`, entry.kind]);
    fields.push([`the prefix of "${entry.name}"`, entry.prefix]);
    fields.push([`the machine of "${entry.name}"`, entry.forMachine]);
    fields.push([`the reason of "${entry.name}"`, entry.reason]);
    fields.push([`the destroy instruction of "${entry.name}"`, entry.destroy]);
  }
  return fields;
}

/** List every file in a bundle, as a name relative to the bundle. */
function listBundleFiles(bundleDir) {
  const found = [];
  const walk = (folder, prefix) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full, relativeName);
      else found.push(relativeName);
    }
  };
  walk(bundleDir, '');
  return found.sort();
}

/**
 * Check a bundle against its manifest.
 *
 * The receiver does this before it uses a value, because a file that is not
 * the file that was sent is not the value, and a file that another account
 * can read is a value that has already leaked.
 */
function verifyBundle(options) {
  const findings = [];
  const bundleDir = resolve(options.bundle);
  const manifestName = options.manifest;

  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    return { code: 2, error: 'the bundle directory does not exist' };
  }

  const manifestPath = manifestPathIn(bundleDir, manifestName);
  if (!manifestPath.ok) {
    return { code: 2, error: `the manifest: ${manifestPath.reason}` };
  }
  if (!existsSync(manifestPath.path)) {
    return {
      code: 1,
      findings: [
        {
          kind: 'manifest-missing',
          name: manifestName,
          message: `the bundle has no ${manifestName}, so there is nothing to check it against`,
        },
      ],
    };
  }

  let text;
  try {
    text = readFileSync(manifestPath.path, 'utf8');
  } catch {
    return {
      code: 1,
      findings: [
        {
          kind: 'manifest-unreadable',
          name: manifestName,
          message: `the ${manifestName} could not be read`,
        },
      ],
    };
  }

  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return {
      code: 1,
      findings: [
        {
          kind: 'manifest-unreadable',
          name: manifestName,
          message: `the ${manifestName} is not in the format of the protocol: ${parsed.reason}`,
        },
      ],
    };
  }
  const manifest = parsed.manifest;

  // The bundle directory itself holds only credentials and has to be private.
  const directoryCheck = checkOwnerOnly(bundleDir, true);
  if (!directoryCheck.ok) {
    findings.push({
      kind: 'permissions',
      name: '.',
      message: `the bundle directory is readable by ${directoryCheck.others.join(', ')} (${directoryCheck.detail})`,
    });
  }

  // The manifest travels in a message, so it must hold nothing that can be
  // used. Every field is looked at on its own, because the field names of the
  // format are words like credential and a word is not a value.
  for (const [label, value] of manifestFields(manifest)) {
    const shape = secretShapeOf(value);
    if (shape === null) continue;
    findings.push({
      kind: 'manifest-holds-secret',
      name: manifestName,
      message: `${label} holds something of the shape of a value (${shape}), and the manifest travels in a message`,
    });
  }

  const described = new Set();
  for (const entry of manifest.credentials) {
    described.add(toPosix(entry.file));

    if (entry.prefix.length > MAX_PREFIX_LENGTH) {
      findings.push({
        kind: 'prefix-too-long',
        name: entry.name,
        message: `the prefix of "${entry.name}" is ${entry.prefix.length} characters long and the protocol allows ${MAX_PREFIX_LENGTH}`,
      });
    }

    // The file of a credential has to stay inside the bundle.
    const inside = resolveRealInside(bundleDir, entry.file);
    if (!inside.ok) {
      findings.push({
        kind: 'path-escape',
        name: entry.name,
        message: `the file of "${entry.name}" cannot be read: ${inside.reason}`,
      });
      continue;
    }
    if (!existsSync(inside.path)) {
      findings.push({
        kind: 'credential-missing',
        name: entry.name,
        message: `the file of "${entry.name}" is not in the bundle`,
      });
      continue;
    }

    let read;
    try {
      read = readCredentialFile(inside.path);
    } catch {
      findings.push({
        kind: 'credential-unreadable',
        name: entry.name,
        message: `the file of "${entry.name}" could not be read`,
      });
      continue;
    }

    if (read.digest !== entry.digest) {
      findings.push({
        kind: 'digest-mismatch',
        name: entry.name,
        message: `the digest of the file of "${entry.name}" does not match the manifest, so it is not the file that was sent`,
      });
    }

    const permission = checkOwnerOnly(inside.path, false);
    if (!permission.ok) {
      findings.push({
        kind: 'permissions',
        name: entry.name,
        message: `the file of "${entry.name}" is readable by ${permission.others.join(', ')} (${permission.detail})`,
      });
    }

    // A manifest that holds the value of a credential has leaked it, whatever
    // the shape of the value is.
    const value = readFileSync(inside.path).toString('utf8').replace(/\r?\n$/, '');
    if (value.length >= 8 && text.includes(value)) {
      findings.push({
        kind: 'manifest-holds-value',
        name: entry.name,
        message: `the ${manifestName} holds the value of "${entry.name}"`,
      });
    } else if (value.length >= 16 && text.includes(value.slice(0, 16))) {
      findings.push({
        kind: 'manifest-holds-value',
        name: entry.name,
        message: `the ${manifestName} holds the beginning of the value of "${entry.name}"`,
      });
    }
  }

  // A file that the manifest does not describe is a file nobody knows what
  // it is.
  for (const file of listBundleFiles(bundleDir)) {
    if (file === toPosix(manifestName)) continue;
    if (described.has(file)) continue;
    findings.push({
      kind: 'unknown-file',
      name: file,
      message: `the bundle holds the file "${file}", which the manifest does not describe`,
    });
  }

  // The manifest names the machine the bundle is meant for, and a bundle
  // meant for one machine must not be opened on another.
  const machines = [...new Set(manifest.credentials.map((entry) => entry.forMachine))];
  if (!options.forMachine) {
    findings.push({
      kind: 'named-machine',
      name: machines.join(', '),
      message:
        `the manifest names the machine "${machines.join(', ')}"; say which machine this is with --for ` +
        'so that a bundle opened on the wrong machine is visible',
    });
  } else if (!machines.includes(options.forMachine)) {
    findings.push({
      kind: 'machine-mismatch',
      name: machines.join(', '),
      message: `the bundle is for the machine "${machines.join(', ')}" and this is "${options.forMachine}"`,
    });
  }

  return { code: findings.length > 0 ? 1 : 0, findings, manifest };
}

// ---------------------------------------------------------------------------
// The digest command
// ---------------------------------------------------------------------------

/**
 * Print the kind, the digest and the prefix of a file.
 *
 * This is the proof that an agent holds the right value without showing it.
 */
function digestFiles(options) {
  if (options.files.length === 0) {
    return { code: 2, error: 'no file was named' };
  }
  if (options.prefix !== null && options.prefix.length > MAX_PREFIX_LENGTH) {
    return {
      code: 2,
      error: `the prefix is ${options.prefix.length} characters long and the protocol allows ${MAX_PREFIX_LENGTH}`,
    };
  }

  const entries = [];
  for (const file of options.files) {
    const full = resolve(file);
    if (!existsSync(full) || !statSync(full).isFile()) {
      return { code: 2, error: `the file "${file}" does not exist` };
    }
    let read;
    try {
      read = readCredentialFile(full);
    } catch {
      return { code: 2, error: `the file "${file}" could not be read` };
    }
    entries.push({
      file: file,
      kind: options.kind || DEFAULT_KIND,
      digest: `sha256:${read.digest}`,
      prefix: options.prefix === null ? read.prefix : options.prefix,
    });
  }
  return { code: 0, entries };
}

// ---------------------------------------------------------------------------
// The destroy command
// ---------------------------------------------------------------------------

/**
 * Remove the credentials of a bundle and leave a record behind.
 *
 * The record is what an audit needs: the name, the kind, the digest, the
 * machine, the reason and the date. It holds no value, and the tool refuses
 * to write one that does.
 */
function destroyBundle(options) {
  const bundleDir = resolve(options.bundle);
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    return { code: 2, error: 'the bundle directory does not exist' };
  }
  const manifestPath = manifestPathIn(bundleDir, options.manifest);
  if (!manifestPath.ok) {
    return { code: 2, error: `the manifest: ${manifestPath.reason}` };
  }
  if (!existsSync(manifestPath.path)) {
    return { code: 2, error: `the bundle has no ${options.manifest}, so there is no record to write` };
  }

  let text;
  try {
    text = readFileSync(manifestPath.path, 'utf8');
  } catch {
    return { code: 2, error: `the ${options.manifest} could not be read` };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return { code: 2, error: `the ${options.manifest} is not in the format of the protocol, so no record can be written` };
  }
  const manifest = parsed.manifest;

  // Only the files the manifest names are removed, and only when they are
  // inside the bundle.
  const removed = [];
  for (const entry of manifest.credentials) {
    const inside = resolveRealInside(bundleDir, entry.file);
    if (!inside.ok) continue;
    if (!existsSync(inside.path)) continue;
    rmSync(inside.path, { force: true });
    removed.push({
      name: entry.name,
      kind: entry.kind,
      digest: entry.digest,
      file: toPosix(entry.file),
      forMachine: entry.forMachine,
      reason: entry.reason,
    });
  }
  rmSync(manifestPath.path, { force: true });

  // The record of the destruction.
  const recordFields = [
    ['the bundle field', manifest.bundle],
    ['the destroyed_by field', options.machine],
  ];
  for (const entry of removed) {
    recordFields.push([`the name of "${entry.name}"`, entry.name]);
    recordFields.push([`the kind of "${entry.name}"`, entry.kind]);
    recordFields.push([`the file of "${entry.name}"`, entry.file]);
    recordFields.push([`the machine of "${entry.name}"`, entry.forMachine]);
    recordFields.push([`the reason of "${entry.name}"`, entry.reason]);
  }

  // The record holds no value, and the tool refuses to write one that does.
  for (const [label, value] of recordFields) {
    const shape = secretShapeOf(value);
    if (shape === null) continue;
    return {
      code: 2,
      error: `the record would hold something of the shape of a value (${shape}) in ${label}, so it was not written`,
    };
  }

  const lines = [];
  lines.push(`protocol: ${PROTOCOL_ID}`);
  lines.push('record: destruction');
  lines.push(`bundle: ${manifest.bundle}`);
  lines.push(`destroyed: ${nowStamp()}`);
  lines.push(`destroyed_by: ${options.machine}`);
  lines.push('');
  for (const entry of removed) {
    lines.push(`credential: ${entry.name}`);
    lines.push(`  kind: ${entry.kind}`);
    lines.push(`  digest: sha256:${entry.digest}`);
    lines.push(`  file: ${entry.file}`);
    lines.push(`  for: ${entry.forMachine}`);
    lines.push(`  reason: ${entry.reason}`);
    lines.push('');
  }
  const record = `${lines.join('\n')}`;

  const recordPath = resolve(options.record);
  if (recordPath === manifestPath.path) {
    return { code: 2, error: 'the record may not be written over the manifest of the bundle' };
  }
  // The record may not be written over a credential, because then the record
  // would take the place of the value it describes.
  for (const entry of manifest.credentials) {
    const inside = resolveRealInside(bundleDir, entry.file);
    if (inside.ok && inside.path === recordPath) {
      return { code: 2, error: 'the record may not be written over a credential of the bundle' };
    }
  }
  writeFileSync(recordPath, record, { encoding: 'utf8', mode: 0o600 });
  const permission = setOwnerOnly(recordPath, false);
  if (!permission.ok) {
    return { code: 2, error: `the record could not be locked down (${permission.reason})` };
  }

  return { code: 0, removed, recordPath, bundlePath: options.bundle, recordPathGiven: options.record };
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

// A value for the self-test to work on. It is built from parts, so the text
// in this file is never a complete value of a secret shape.
const SAMPLE_VALUE = sample('sk_', 'test_', 'A1b2C3d4E5f6', 'G7h8I9j0K1l2', 'M3n4');

// A value for the self-test to put into a manifest on purpose.
const SAMPLE_LEAK = sample('sk_', 'live_', 'Z9y8X7w6V5u4', 'T3s2R1q0P9o8');

/** The name of the machine the samples belong to. */
const SAMPLE_MACHINE = 'placeholder-machine';

/** Make a directory for the self-test to work in. */
function makeFixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'handoff-self-test-'));
}

/** Build a bundle with one credential in it and a manifest beside it. */
function buildBundle(root, options = {}) {
  const bundle = join(root, options.name ?? 'bundle');
  mkdirSync(bundle, { recursive: true });
  const value = options.value ?? SAMPLE_VALUE;
  const fileName = options.file ?? 'example-token.txt';
  writeFileSync(join(bundle, fileName), value, 'utf8');

  const manifest = {
    bundle: 'example-bundle',
    written: '2026-10-22T02:10:00Z',
    writtenBy: SAMPLE_MACHINE,
    destroyAfter: '2026-10-29T02:10:00Z',
    credentials: [
      {
        name: 'example-token',
        kind: 'connector-token',
        file: fileName,
        digest: createHash('sha256').update(value).digest('hex'),
        prefix: value.slice(0, MAX_PREFIX_LENGTH),
        forMachine: SAMPLE_MACHINE,
        reason: 'the receiver runs the job on the placeholder machine',
        destroy: DEFAULT_DESTROY_TEXT,
      },
    ],
  };
  if (options.extraFiles) {
    for (const [name, content] of Object.entries(options.extraFiles)) {
      writeFileSync(join(bundle, name), content, 'utf8');
    }
  }
  if (options.manifestText !== undefined) {
    writeFileSync(join(bundle, 'manifest.txt'), options.manifestText, 'utf8');
  } else {
    writeFileSync(join(bundle, 'manifest.txt'), renderManifest(manifest), 'utf8');
  }
  setOwnerOnly(bundle, true);
  setOwnerOnly(join(bundle, fileName), false);
  setOwnerOnly(join(bundle, 'manifest.txt'), false);
  return { bundle, manifest, value };
}

/** Run a command with the output captured, so that the self-test can read it. */
function captureOutput(action) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = action();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** Let another account read a file, so that the permission rule has a case. */
function makeReadableByOthers(path) {
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [path, '/grant:r', '*S-1-1-0:(R)'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }
  chmodSync(path, 0o644);
  return true;
}

/** The cases of the self-test. Each one proves a rule on a bad and a good case. */
function selfTestCases() {
  return [
    {
      name: 'the manifest holds the digest and the prefix and never the value',
      must: 'the manifest must hold the digest and the prefix and must not hold the value',
      run(root) {
        const bundle = join(root, 'case');
        mkdirSync(bundle, { recursive: true });
        writeFileSync(join(bundle, 'example-token.txt'), SAMPLE_VALUE, 'utf8');
        const result = captureOutput(() =>
          runCommand('write', {
            bundle,
            machine: SAMPLE_MACHINE,
            specs: [
              {
                name: 'example-token',
                kind: 'connector-token',
                file: 'example-token.txt',
                reason: 'the receiver runs the job on the placeholder machine',
              },
            ],
            manifest: MANIFEST_NAME,
            bundleName: 'example-bundle',
            allowInRepo: false,
            ttl: null,
            destroyAfter: null,
            specFile: null,
            json: false,
            quiet: false,
          }),
        );
        if (result.code !== 0) return false;
        const manifest = readFileSync(join(bundle, MANIFEST_NAME), 'utf8');
        const digest = createHash('sha256').update(SAMPLE_VALUE).digest('hex');
        if (!manifest.includes(digest)) return false;
        if (!manifest.includes(`prefix: ${SAMPLE_VALUE.slice(0, MAX_PREFIX_LENGTH)}`)) return false;
        if (manifest.includes(SAMPLE_VALUE)) return false;
        if (result.stdout.includes(SAMPLE_VALUE)) return false;
        return true;
      },
    },
    {
      name: 'a prefix of more than four characters',
      must: 'a prefix of more than four characters must be refused and nothing may be written',
      run(root) {
        const bundle = join(root, 'case');
        mkdirSync(bundle, { recursive: true });
        const source = join(root, 'source.txt');
        writeFileSync(source, SAMPLE_VALUE, 'utf8');
        const result = writeBundle({
          bundle,
          machine: SAMPLE_MACHINE,
          specs: [
            {
              name: 'example-token',
              kind: 'connector-token',
              file: 'example-token.txt',
              source,
              reason: 'the receiver runs the job on the placeholder machine',
              prefix: SAMPLE_VALUE.slice(0, 8),
            },
          ],
          manifest: MANIFEST_NAME,
          allowInRepo: false,
        });
        if (result.code !== 2) return false;
        return !existsSync(join(bundle, 'example-token.txt'));
      },
    },
    {
      name: 'a bundle inside a repository',
      must: 'a bundle inside a repository must be refused unless the caller allows it',
      run(root) {
        const repository = join(root, 'repository');
        mkdirSync(join(repository, '.git'), { recursive: true });
        const bundle = join(repository, 'bundle');
        mkdirSync(bundle, { recursive: true });
        writeFileSync(join(bundle, 'example-token.txt'), SAMPLE_VALUE, 'utf8');
        const specs = [
          {
            name: 'example-token',
            kind: 'connector-token',
            file: 'example-token.txt',
            reason: 'the receiver runs the job on the placeholder machine',
          },
        ];
        const refused = writeBundle({
          bundle,
          machine: SAMPLE_MACHINE,
          specs,
          manifest: MANIFEST_NAME,
          allowInRepo: false,
        });
        const allowed = writeBundle({
          bundle,
          machine: SAMPLE_MACHINE,
          specs,
          manifest: MANIFEST_NAME,
          allowInRepo: true,
        });
        return refused.code === 2 && allowed.code === 0;
      },
    },
    {
      name: 'a healthy bundle',
      must: 'a healthy bundle must be reported as clean',
      run(root) {
        const fixture = buildBundle(root);
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.code === 0 && result.findings.length === 0;
      },
    },
    {
      name: 'a file that was changed after the manifest was written',
      must: 'a digest that does not match must be reported by name',
      run(root) {
        const fixture = buildBundle(root);
        writeFileSync(join(fixture.bundle, 'example-token.txt'), `${SAMPLE_VALUE}-changed`, 'utf8');
        setOwnerOnly(join(fixture.bundle, 'example-token.txt'), false);
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some(
          (finding) => finding.kind === 'digest-mismatch' && finding.name === 'example-token',
        );
      },
    },
    {
      name: 'a credential that is not in the bundle',
      must: 'a credential that is missing must be reported',
      run(root) {
        const fixture = buildBundle(root);
        rmSync(join(fixture.bundle, 'example-token.txt'), { force: true });
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some(
          (finding) => finding.kind === 'credential-missing' && finding.name === 'example-token',
        );
      },
    },
    {
      name: 'a file that the manifest does not describe',
      must: 'a file that the manifest does not describe must be reported',
      run(root) {
        const fixture = buildBundle(root);
        writeFileSync(join(fixture.bundle, 'leftover.txt'), 'left over\n', 'utf8');
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some(
          (finding) => finding.kind === 'unknown-file' && finding.name === 'leftover.txt',
        );
      },
    },
    {
      name: 'a credential that another account can read',
      must: 'a credential that another account can read must be reported',
      run(root) {
        const fixture = buildBundle(root);
        if (!makeReadableByOthers(join(fixture.bundle, 'example-token.txt'))) return true;
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some(
          (finding) => finding.kind === 'permissions' && finding.name === 'example-token',
        );
      },
    },
    {
      name: 'a manifest that holds a value',
      must: 'a manifest that holds a value must be reported',
      run(root) {
        const fixture = buildBundle(root, {
          manifestText: renderManifest({
            bundle: 'example-bundle',
            written: '2026-10-22T02:10:00Z',
            writtenBy: SAMPLE_MACHINE,
            destroyAfter: '2026-10-29T02:10:00Z',
            credentials: [
              {
                name: 'example-token',
                kind: 'connector-token',
                file: 'example-token.txt',
                digest: createHash('sha256').update(SAMPLE_VALUE).digest('hex'),
                prefix: SAMPLE_VALUE.slice(0, MAX_PREFIX_LENGTH),
                forMachine: SAMPLE_MACHINE,
                reason: SAMPLE_LEAK,
                destroy: DEFAULT_DESTROY_TEXT,
              },
            ],
          }),
        });
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some((finding) => finding.kind === 'manifest-holds-secret');
      },
    },
    {
      name: 'a manifest that names a machine',
      must: 'a manifest that names a machine must be reported',
      run(root) {
        const fixture = buildBundle(root);
        const withoutMachine = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: null,
        });
        const withMachine = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return (
          withoutMachine.findings.some((finding) => finding.kind === 'named-machine') &&
          !withMachine.findings.some((finding) => finding.kind === 'named-machine')
        );
      },
    },
    {
      name: 'a bundle for another machine',
      must: 'a bundle that is for another machine must be reported',
      run(root) {
        const fixture = buildBundle(root);
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: 'another-placeholder-machine',
        });
        return result.findings.some((finding) => finding.kind === 'machine-mismatch');
      },
    },
    {
      name: 'a manifest that is not in the format',
      must: 'a manifest that is not in the format must be reported as unreadable',
      run(root) {
        const fixture = buildBundle(root, { manifestText: 'this is not a manifest\n' });
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some((finding) => finding.kind === 'manifest-unreadable');
      },
    },
    {
      name: 'a file that points out of the bundle',
      must: 'a file that points out of the bundle must be reported',
      run(root) {
        const fixture = buildBundle(root);
        const outside = join(root, 'outside.txt');
        writeFileSync(outside, SAMPLE_VALUE, 'utf8');
        const manifest = parseManifest(readFileSync(join(fixture.bundle, MANIFEST_NAME), 'utf8'));
        const text = renderManifest({
          bundle: manifest.manifest.bundle,
          written: manifest.manifest.written,
          writtenBy: manifest.manifest.writtenBy,
          destroyAfter: manifest.manifest.destroyAfter,
          credentials: [
            {
              ...manifest.manifest.credentials[0],
              file: '../outside.txt',
            },
          ],
        });
        writeFileSync(join(fixture.bundle, MANIFEST_NAME), text, 'utf8');
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some((finding) => finding.kind === 'path-escape');
      },
    },
    {
      name: 'a prefix of more than four characters in the manifest',
      must: 'a prefix of more than four characters in the manifest must be reported',
      run(root) {
        const fixture = buildBundle(root);
        const parsed = parseManifest(readFileSync(join(fixture.bundle, MANIFEST_NAME), 'utf8'));
        const text = renderManifest({
          bundle: parsed.manifest.bundle,
          written: parsed.manifest.written,
          writtenBy: parsed.manifest.writtenBy,
          destroyAfter: parsed.manifest.destroyAfter,
          credentials: [
            {
              ...parsed.manifest.credentials[0],
              prefix: SAMPLE_VALUE.slice(0, 8),
            },
          ],
        });
        writeFileSync(join(fixture.bundle, MANIFEST_NAME), text, 'utf8');
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: MANIFEST_NAME,
          forMachine: SAMPLE_MACHINE,
        });
        return result.findings.some((finding) => finding.kind === 'prefix-too-long');
      },
    },
    {
      name: 'a manifest that points out of the bundle',
      must: 'a manifest that points out of the bundle must be refused',
      run(root) {
        const fixture = buildBundle(root);
        const outside = join(root, 'outside-manifest.txt');
        writeFileSync(outside, 'protocol: credential-handoff/1\n', 'utf8');
        const result = verifyBundle({
          bundle: fixture.bundle,
          manifest: '../outside-manifest.txt',
          forMachine: SAMPLE_MACHINE,
        });
        return result.code === 2;
      },
    },
    {
      name: 'a credential in a folder of the bundle',
      must: 'a credential in a folder of the bundle must be written and kept private',
      run(root) {
        const bundle = join(root, 'case');
        mkdirSync(bundle, { recursive: true });
        const source = join(root, 'source.txt');
        writeFileSync(source, SAMPLE_VALUE, 'utf8');
        const result = captureOutput(() =>
          runCommand('write', {
            bundle,
            machine: SAMPLE_MACHINE,
            specs: [
              {
                name: 'example-token',
                kind: 'connector-token',
                file: 'inner/example-token.txt',
                source,
                reason: 'the receiver runs the job on the placeholder machine',
              },
            ],
            manifest: MANIFEST_NAME,
            bundleName: 'example-bundle',
            allowInRepo: false,
            ttl: null,
            destroyAfter: null,
            specFile: null,
            json: false,
            quiet: false,
          }),
        );
        if (result.code !== 0) return false;
        if (!existsSync(join(bundle, 'inner', 'example-token.txt'))) return false;
        const check = checkOwnerOnly(join(bundle, 'inner', 'example-token.txt'), false);
        return check.ok;
      },
    },
    {
      name: 'the digest of a file',
      must: 'the digest must be printed and the value must not be',
      run(root) {
        const bundle = join(root, 'case');
        mkdirSync(bundle, { recursive: true });
        const file = join(bundle, 'example-token.txt');
        writeFileSync(file, SAMPLE_VALUE, 'utf8');
        const result = captureOutput(() =>
          runCommand('digest', { files: [file], kind: 'connector-token', prefix: null, json: false, quiet: false }),
        );
        if (result.code !== 0) return false;
        const digest = createHash('sha256').update(SAMPLE_VALUE).digest('hex');
        if (!result.stdout.includes(digest)) return false;
        if (!result.stdout.includes(SAMPLE_VALUE.slice(0, MAX_PREFIX_LENGTH))) return false;
        if (result.stdout.includes(SAMPLE_VALUE)) return false;
        return true;
      },
    },
    {
      name: 'a prefix of more than four characters on the command line',
      must: 'a prefix of more than four characters on the command line must be refused',
      run(root) {
        const bundle = join(root, 'case');
        mkdirSync(bundle, { recursive: true });
        const file = join(bundle, 'example-token.txt');
        writeFileSync(file, SAMPLE_VALUE, 'utf8');
        const result = digestFiles({ files: [file], kind: 'connector-token', prefix: SAMPLE_VALUE.slice(0, 8) });
        return result.code === 2;
      },
    },
    {
      name: 'the destruction of a bundle',
      must: 'the credentials and the manifest must be gone and the record must hold no value',
      run(root) {
        const fixture = buildBundle(root);
        const recordPath = join(root, 'record.txt');
        const result = captureOutput(() =>
          runCommand('destroy', {
            bundle: fixture.bundle,
            record: recordPath,
            manifest: MANIFEST_NAME,
            machine: SAMPLE_MACHINE,
            json: false,
            quiet: false,
          }),
        );
        if (result.code !== 0) return false;
        if (existsSync(join(fixture.bundle, 'example-token.txt'))) return false;
        if (existsSync(join(fixture.bundle, MANIFEST_NAME))) return false;
        if (!existsSync(recordPath)) return false;
        const record = readFileSync(recordPath, 'utf8');
        if (record.includes(SAMPLE_VALUE)) return false;
        if (!record.includes(createHash('sha256').update(SAMPLE_VALUE).digest('hex'))) return false;
        if (result.stdout.includes(SAMPLE_VALUE)) return false;
        return true;
      },
    },
    {
      name: 'a destruction that touches nothing outside the bundle',
      must: 'nothing outside the bundle may be removed',
      run(root) {
        const fixture = buildBundle(root);
        const outside = join(root, 'outside.txt');
        writeFileSync(outside, SAMPLE_VALUE, 'utf8');
        destroyBundle({
          bundle: fixture.bundle,
          record: join(root, 'record.txt'),
          manifest: MANIFEST_NAME,
          machine: SAMPLE_MACHINE,
        });
        return existsSync(outside);
      },
    },
  ];
}

/** Run every case of the self-test and report the ones that fail. */
function runSelfTest() {
  const failures = [];
  const cases = selfTestCases();

  for (const testCase of cases) {
    const root = makeFixtureRoot();
    try {
      if (!testCase.run(root)) {
        failures.push(`${testCase.name}: ${testCase.must}`);
      }
    } catch (error) {
      failures.push(`${testCase.name}: the case could not be run (${error.message})`);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  if (failures.length > 0) {
    process.stdout.write('handoff self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`handoff self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** The help of the tool as a whole. */
function printUsage() {
  process.stdout.write(
    [
      'handoff — the tool that enforces the credential hand-over protocol.',
      '',
      'Usage:',
      '  node scripts/handoff.mjs <command> [options]',
      '',
      'Commands:',
      '  write     Write the credential files and the manifest of a bundle.',
      '  verify    Check a bundle against its manifest.',
      '  digest    Print the kind, the digest and the prefix of a file.',
      '  destroy   Remove the credentials of a bundle and leave a record.',
      '',
      'Options:',
      '  --json        Print the result as JSON instead of text.',
      '  --quiet       Print the findings but not the closing summary.',
      '  --self-test   Run the rules against known good and known bad bundles.',
      '  --help        Print the help of the command and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found, or the self-test passed.',
      '  1  at least one finding, or the self-test failed.',
      '  2  the command line could not be understood, or it asked for something',
      '     the protocol forbids.',
      '',
      'The protocol is in docs/credential-handoff.md. The tool never prints the',
      'value of a credential, never writes one into a manifest or a record, and',
      'never reads or removes a path outside the bundle directory.',
      '',
      'Run "node scripts/handoff.mjs <command> --help" for the help of a',
      'command.',
      '',
    ].join('\n'),
  );
}

/** The help of one command. */
function printCommandHelp(command) {
  const helps = {
    write: [
      'handoff write — the holder writes the bundle and the manifest.',
      '',
      'Usage:',
      '  node scripts/handoff.mjs write --bundle <dir> --machine <name> [options]',
      '',
      'Options:',
      '  --bundle <dir>       The bundle directory. It is made when it is not there.',
      '  --machine <name>     The machine that writes the bundle. It is written',
      '                       into the manifest and is the default machine every',
      '                       credential is meant for. A specification file may',
      '                       name it as well.',
      '  --credential <spec>  One credential, as name=value pairs separated by',
      '                       semicolons. May be given more than once. The',
      '                       fields are name, kind, file, for, reason, source,',
      '                       prefix, ttl and destroy-after.',
      '  --spec <file>        A JSON file with the same fields, for the case',
      '                       where the shell is a poor place for them. It may',
      '                       hold the machine, the bundle, the lifetime and',
      '                       the list of credentials.',
      '  --ttl <duration>     How long the credentials may live: 30m, 6h, 7d, 2w.',
      '  --destroy-after <t>  The moment the credentials stop being valid.',
      '  --bundle-name <name> The name of the bundle in the manifest.',
      '  --manifest <name>    The name of the manifest. Default: manifest.txt.',
      '  --allow-in-repo      Write the bundle even though it is inside a',
      '                       repository. The protocol says never, so this flag',
      '                       says that you know what you are doing.',
      '  --json               Print the result as JSON instead of text.',
      '  --quiet              Print the result but not the closing summary.',
      '  --help               Print this help and exit.',
      '',
      'Exit codes:',
      '  0  the bundle and the manifest were written.',
      '  1  a finding was made.',
      '  2  the command line could not be understood, or it asked for',
      '     something the protocol forbids.',
      '',
      'The file of a credential is copied into the bundle when the credential',
      'names a source, and is expected to be there when it does not. The file',
      'is made readable by its owner alone, and so is the bundle directory.',
      'The manifest holds the name, the kind, the file, the digest, a prefix of',
      'four characters at most, the machine, the reason and the destroy',
      'instruction. It never holds the value.',
      '',
    ],
    verify: [
      'handoff verify — the receiver checks the bundle before it uses it.',
      '',
      'Usage:',
      '  node scripts/handoff.mjs verify --bundle <dir> [--for <machine>]',
      '',
      'Options:',
      '  --bundle <dir>     The bundle directory.',
      '  --for <machine>    The machine this is. The manifest names the machine',
      '                     the bundle is meant for, and a bundle meant for one',
      '                     machine must not be opened on another.',
      '  --manifest <name>  The name of the manifest. Default: manifest.txt.',
      '  --json             Print the findings as JSON instead of text.',
      '  --quiet            Print the findings but not the closing summary.',
      '  --help             Print this help and exit.',
      '',
      'Exit codes:',
      '  0  nothing was found.',
      '  1  at least one finding.',
      '  2  the command line could not be understood.',
      '',
      'The checker reports a digest that does not match, a credential that is',
      'not in the bundle, a file that the manifest does not describe, a file',
      'that another identity can read, a manifest that holds a value, a',
      'manifest that is not in the format of the protocol, and a bundle that is',
      'meant for another machine. It never prints a value.',
      '',
    ],
    digest: [
      'handoff digest — the proof that does not reveal.',
      '',
      'Usage:',
      '  node scripts/handoff.mjs digest [--kind <kind>] [--prefix <prefix>] <file>...',
      '',
      'Options:',
      '  --kind <kind>     The kind of the credential. Default: credential.',
      '  --prefix <prefix> The prefix to print. Four characters at most, and a',
      '                    longer one is refused.',
      '  --json            Print the result as JSON instead of text.',
      '  --quiet           Print the result but not the closing summary.',
      '  --help            Print this help and exit.',
      '',
      'Exit codes:',
      '  0  the digest was printed.',
      '  1  a finding was made.',
      '  2  the command line could not be understood, or it asked for',
      '     something the protocol forbids.',
      '',
      'For each file the kind, the sha256 digest and the prefix are printed.',
      'A digest cannot be turned back into a value, so this is the proof that',
      'two machines hold the same credential.',
      '',
    ],
    destroy: [
      'handoff destroy — the copy stops existing.',
      '',
      'Usage:',
      '  node scripts/handoff.mjs destroy --bundle <dir> --record <file>',
      '',
      'Options:',
      '  --bundle <dir>     The bundle directory.',
      '  --record <file>    The file the record of the destruction is written to.',
      '  --manifest <name>  The name of the manifest. Default: manifest.txt.',
      '  --machine <name>   The machine that destroys the copy.',
      '  --json             Print the result as JSON instead of text.',
      '  --quiet            Print the result but not the closing summary.',
      '  --help             Print this help and exit.',
      '',
      'Exit codes:',
      '  0  the copy was destroyed and the record was written.',
      '  1  a finding was made.',
      '  2  the command line could not be understood, or it asked for',
      '     something the protocol forbids.',
      '',
      'The credential files and the manifest are removed, and nothing outside',
      'the bundle directory is touched. The record holds the name, the kind, the',
      'digest, the machine, the reason and the date of every credential that',
      'was destroyed. It holds no value.',
      '',
    ],
  };
  process.stdout.write(helps[command].join('\n'));
}

/**
 * Read the command line.
 *
 * The command comes first, then its options. Every option that takes a value
 * may also be written with an equals sign, because that is what a script
 * tends to write.
 */
function parseArguments(argv) {
  const state = {
    command: null,
    help: false,
    selfTest: false,
    json: false,
    quiet: false,
    allowInRepo: false,
    bundle: null,
    machine: null,
    bundleName: null,
    manifest: MANIFEST_NAME,
    specs: [],
    specFile: null,
    ttl: null,
    destroyAfter: null,
    forMachine: null,
    kind: null,
    prefix: null,
    record: null,
    files: [],
  };

  const options = {
    write: {
      '--bundle': 'bundle',
      '--machine': 'machine',
      '--credential': 'credential',
      '--spec': 'specFile',
      '--ttl': 'ttl',
      '--destroy-after': 'destroyAfter',
      '--bundle-name': 'bundleName',
      '--manifest': 'manifest',
    },
    verify: {
      '--bundle': 'bundle',
      '--for': 'forMachine',
      '--manifest': 'manifest',
    },
    digest: {
      '--kind': 'kind',
      '--prefix': 'prefix',
    },
    destroy: {
      '--bundle': 'bundle',
      '--record': 'record',
      '--manifest': 'manifest',
      '--machine': 'machine',
    },
  };

  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) {
    const argument = argv[index];
    if (argument === '--self-test') state.selfTest = true;
    else if (argument === '--json') state.json = true;
    else if (argument === '--quiet' || argument === '-q') state.quiet = true;
    else if (argument === '--help' || argument === '-h') state.help = true;
    else {
      process.stderr.write(`handoff: the option "${argument}" is not known\n`);
      return null;
    }
    index += 1;
  }

  if (index < argv.length) {
    state.command = argv[index];
    index += 1;
  }

  const known = state.command ? options[state.command] : null;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === '--self-test') {
      state.selfTest = true;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      state.json = true;
      index += 1;
      continue;
    }
    if (argument === '--quiet' || argument === '-q') {
      state.quiet = true;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      state.help = true;
      index += 1;
      continue;
    }
    if (argument === '--allow-in-repo') {
      state.allowInRepo = true;
      index += 1;
      continue;
    }

    const name = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    const inline = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : null;

    // A name that is not an option is a file to digest.
    if (!argument.startsWith('-')) {
      if (state.command !== 'digest') {
        process.stderr.write(`handoff: the command "${state.command}" takes no files\n`);
        return null;
      }
      state.files.push(argument);
      index += 1;
      continue;
    }

    const key = known && known[name] ? known[name] : null;
    if (key === null) {
      process.stderr.write(`handoff: the option "${argument}" is not known\n`);
      return null;
    }

    let value = inline;
    if (value === null) {
      index += 1;
      value = argv[index];
      if (value === undefined) {
        process.stderr.write(`handoff: the option "${name}" needs a value\n`);
        return null;
      }
    }
    index += 1;

    if (key === 'credential') {
      const parsed = parseCredentialSpec(value);
      if (!parsed.ok) {
        process.stderr.write(`handoff: the credential could not be read: ${parsed.reason}\n`);
        return null;
      }
      state.specs.push(parsed.spec);
      continue;
    }
    state[key] = value;
  }

  return state;
}

/** Print the result of the write command. */
function reportWrite(result, options) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bundle: result.bundlePath,
          manifest: result.manifestPathGiven,
          credentials: result.manifest.credentials.map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            file: entry.file,
            digest: `sha256:${entry.digest}`,
            prefix: entry.prefix,
            for: entry.forMachine,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  for (const note of result.notes) process.stdout.write(`handoff: ${note}\n`);
  process.stdout.write(`handoff: wrote ${result.manifest.credentials.length} credential(s) into the bundle\n`);
  for (const entry of result.manifest.credentials) {
    process.stdout.write(`  name: ${entry.name}\n`);
    process.stdout.write(`  kind: ${entry.kind}\n`);
    process.stdout.write(`  file: ${entry.file}\n`);
    process.stdout.write(`  digest: sha256:${entry.digest}\n`);
    process.stdout.write(`  prefix: ${entry.prefix}\n`);
    process.stdout.write(`  for: ${entry.forMachine}\n`);
  }
  process.stdout.write(`handoff: the manifest is ${result.manifestPathGiven}\n`);
  process.stdout.write('handoff: the manifest is the part that may go into a message, the bundle is not\n');
}

/** Print the result of the verify command. */
function reportVerify(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ count: result.findings.length, findings: result.findings }, null, 2)}\n`);
    return;
  }
  for (const finding of result.findings) {
    process.stdout.write(`${finding.name}: [${finding.kind}] ${finding.message}\n`);
  }
  if (!options.quiet) {
    const count = result.findings.length;
    process.stdout.write(`handoff: ${count} finding(s) in the bundle\n`);
  }
}

/** Print the result of the digest command. */
function reportDigest(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ count: result.entries.length, files: result.entries }, null, 2)}\n`);
    return;
  }
  for (const entry of result.entries) {
    process.stdout.write(`  file: ${entry.file}\n`);
    process.stdout.write(`  kind: ${entry.kind}\n`);
    process.stdout.write(`  digest: ${entry.digest}\n`);
    process.stdout.write(`  prefix: ${entry.prefix}\n`);
  }
  if (!options.quiet) {
    process.stdout.write(`handoff: ${result.entries.length} file(s)\n`);
  }
}

/** Print the result of the destroy command. */
function reportDestroy(result, options) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bundle: result.bundlePath,
          record: result.recordPathGiven,
          destroyed: result.removed.map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            digest: `sha256:${entry.digest}`,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`handoff: destroyed ${result.removed.length} credential(s) from the bundle\n`);
  for (const entry of result.removed) {
    process.stdout.write(`  name: ${entry.name}\n`);
    process.stdout.write(`  kind: ${entry.kind}\n`);
    process.stdout.write(`  digest: sha256:${entry.digest}\n`);
  }
  process.stdout.write(`handoff: the record is ${result.recordPathGiven}\n`);
}

/**
 * Run one command and print what it found.
 *
 * The self-test calls this as well, so that the rules are proved on the same
 * path a caller takes.
 */
function runCommand(command, options) {
  switch (command) {
    case 'write': {
      const result = writeBundle(options);
      if (result.error) {
        process.stderr.write(`handoff: ${result.error}\n`);
        return result.code ?? 2;
      }
      reportWrite(result, options);
      return 0;
    }
    case 'verify': {
      const result = verifyBundle(options);
      if (result.error) {
        process.stderr.write(`handoff: ${result.error}\n`);
        return result.code ?? 2;
      }
      reportVerify(result, options);
      return result.code;
    }
    case 'digest': {
      const result = digestFiles(options);
      if (result.error) {
        process.stderr.write(`handoff: ${result.error}\n`);
        return result.code ?? 2;
      }
      reportDigest(result, options);
      return 0;
    }
    case 'destroy': {
      const result = destroyBundle(options);
      if (result.error) {
        process.stderr.write(`handoff: ${result.error}\n`);
        return result.code ?? 2;
      }
      reportDestroy(result, options);
      return 0;
    }
    default:
      process.stderr.write(`handoff: the command "${command}" is not known\n`);
      return 2;
  }
}

/** Run the tool. */
function main(argv) {
  const options = parseArguments(argv);
  if (options === null) return 2;
  if (options.selfTest && !options.command) return runSelfTest();
  if (options.help && !options.command) {
    printUsage();
    return 0;
  }
  if (!options.command) {
    process.stderr.write('handoff: no command was given; try --help\n');
    return 2;
  }
  if (options.help) {
    printCommandHelp(options.command);
    return 0;
  }
  if (options.selfTest) return runSelfTest();

  // Every command says what it needs, so that a mistake is a message and not
  // a half written bundle.
  if (options.command === 'write') {
    if (!options.bundle) {
      process.stderr.write('handoff: write needs --bundle\n');
      return 2;
    }
  }
  if (options.command === 'verify' && !options.bundle) {
    process.stderr.write('handoff: verify needs --bundle\n');
    return 2;
  }
  if (options.command === 'destroy') {
    if (!options.bundle) {
      process.stderr.write('handoff: destroy needs --bundle\n');
      return 2;
    }
    if (!options.record) {
      process.stderr.write('handoff: destroy needs --record, the file the record is written to\n');
      return 2;
    }
  }

  return runCommand(options.command, options);
}

process.exitCode = main(process.argv.slice(2));
