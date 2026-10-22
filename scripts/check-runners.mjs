#!/usr/bin/env node
/**
 * check-runners.mjs — a runner label checker for a repository.
 *
 * A workflow names a runner by a label that belonged to a machine which has
 * since been retired. Because the label is a string, nothing in the
 * repository is invalid, the workflow file parses, and the failure only
 * appears in the check: the pull request fails for a reason that has nothing
 * to do with the change.
 *
 * The checker reads the workflow files of a repository, lists every runner
 * label they name, and compares those labels with the labels that are
 * actually available. The available labels come from a configuration file
 * that maps a label to the machine that answers it, so the checker never has
 * to reach a machine to know which labels exist.
 *
 * The checker reports:
 *
 *   - a label that a workflow names and that no configured machine answers;
 *   - a workflow that names a runner by a floating tag rather than by a
 *     version, because that is how a runner changes under a workflow without
 *     anyone editing it;
 *   - a workflow that names no runner at all, together with the default it
 *     will use.
 *
 * The checker uses nothing but the Node standard library, it runs the same
 * way on Linux, macOS and Windows, and it needs no installation step.
 *
 * Usage:
 *   node scripts/check-runners.mjs [options]
 *
 * Options:
 *   --repo <dir>      The repository to check. Default: the repository the
 *                     script lives in.
 *   --dir <path>      The directory that holds the workflow files.
 *                     Default: .github/workflows.
 *   --config <file>   The file that maps a label to the machine that answers
 *                     it. Default: scripts/runners.example.json of the
 *                     repository, or the example that sits next to this
 *                     script.
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
 * The shape of the configuration file is documented in
 * scripts/runners.example.json, which ships with this checker:
 *
 *   {
 *     "version": 1,
 *     "default": "build-pool",
 *     "labels": {
 *       "build-pool": { "machine": "machine-01", "kind": "group" }
 *     }
 *   }
 *
 * A label may also be written as the name of the machine alone, so
 * "build-pool": "machine-01" means the same thing.
 *
 * What the checker never does:
 *   - it never reaches a machine and never runs a workflow;
 *   - it never writes to the repository;
 *   - it never prints the contents of a workflow file, only the name of the
 *     file, the line, the job and the label.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The directory that holds the workflow files, when the caller does not say.
const DEFAULT_DIRECTORY = '.github/workflows';

// The name of the example configuration file that ships with the checker.
const EXAMPLE_CONFIG_NAME = 'runners.example.json';

// A tag that pins one exact build: the numbers of a version, with an
// optional suffix. Anything else after the colon is a floating tag.
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Turn a native path into a POSIX style path so the output is the same everywhere. */
function toPosix(path) {
  return path.split(sep).join('/');
}

/** The number of spaces at the start of a line. */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** True when the line carries nothing but a comment or nothing at all. */
function isBlankLine(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/** Remove the comment that may follow a value, and keep the quotes. */
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index);
    }
  }
  return text;
}

/** Read a scalar and take the quotes off it. */
function readScalar(text) {
  let value = stripComment(text).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return value.trim();
}

/**
 * Split a flow collection on the commas that are not inside a bracket or a
 * quoted value.
 */
function splitFlow(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[' || character === '{') {
      depth += 1;
      current += character;
      continue;
    }
    if (character === ']' || character === '}') {
      depth -= 1;
      current += character;
      continue;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * Read a mapping entry: a key, and the value that follows it.
 *
 * A colon only separates a key from a value when a space follows it, which
 * is the rule of the format itself. A label such as pool:2024.06.1 is
 * therefore a plain value and not a mapping, and this function says so.
 */
function readMapping(text) {
  const match = /^(\s*)([^\s#][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
  if (!match) return null;
  return { name: match[2].trim(), value: (match[3] ?? '').trim() };
}

/**
 * Read a key and its value out of a line. A line that starts with a dash is
 * an item of a sequence rather than a key of a mapping, and an item may
 * hold a plain value rather than a nested mapping.
 */
function readKey(text) {
  const item = /^(\s*)-\s+/.exec(text);
  if (item) {
    const rest = text.slice(item[0].length);
    const key = readMapping(rest);
    if (key === null) {
      return { indent: item[1].length, isItem: true, name: null, value: rest.trim() };
    }
    return { indent: item[1].length, isItem: true, name: key.name, value: key.value };
  }
  const key = readMapping(text);
  if (key === null) return null;
  return { indent: 0, isItem: false, name: key.name, value: key.value };
}

// ---------------------------------------------------------------------------
// Reading the workflow files
// ---------------------------------------------------------------------------

/** Read the lines that belong to a block that sits under a key. */
function readBlock(lines, start, indent) {
  const block = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line)) {
      index += 1;
      continue;
    }
    if (indentOf(line) <= indent) break;
    block.push({ text: line, indent: indentOf(line), number: index + 1 });
    index += 1;
  }
  return block;
}

/** Read the lines that belong to a block that sits under one entry. */
function readNestedBlock(block, entry) {
  const nested = [];
  let index = block.indexOf(entry) + 1;
  while (index < block.length && block[index].indent > entry.indent) {
    nested.push(block[index]);
    index += 1;
  }
  return nested;
}

/** Read the jobs of a workflow file. */
function readJobs(lines) {
  const jobs = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^jobs\s*:/.test(lines[index])) continue;
    const block = readBlock(lines, index + 1, 0);
    if (block.length === 0) return jobs;
    const baseIndent = block[0].indent;
    let cursor = 0;
    while (cursor < block.length) {
      const entry = block[cursor];
      const key = readKey(entry.text);
      if (!key) {
        cursor += 1;
        continue;
      }
      const jobLines = [];
      let inner = cursor + 1;
      while (inner < block.length && block[inner].indent > baseIndent) {
        jobLines.push(block[inner]);
        inner += 1;
      }
      jobs.push({ name: key.name, line: entry.number, lines: jobLines });
      cursor = inner;
    }
    break;
  }
  return jobs;
}

/** Find the runner key of a job and the value it carries. */
function readRunner(job) {
  if (job.lines.length === 0) return null;
  const propertyIndent = job.lines[0].indent;
  for (let index = 0; index < job.lines.length; index += 1) {
    const line = job.lines[index];
    if (line.indent !== propertyIndent) continue;
    const key = readKey(line.text);
    if (!key || key.isItem || key.name !== 'runs-on') continue;
    if (key.value.length > 0 && !key.value.startsWith('#')) {
      return { line: line.number, inline: key.value };
    }
    const block = [];
    let cursor = index + 1;
    while (cursor < job.lines.length && job.lines[cursor].indent > propertyIndent) {
      block.push(job.lines[cursor]);
      cursor += 1;
    }
    return { line: line.number, block };
  }
  return null;
}

/** Read the labels out of a value that sits on one line. */
function readLabelsFromText(text) {
  const value = stripComment(text).trim();
  if (value.length === 0) return [];

  if (value.startsWith('[')) {
    return splitFlow(value.slice(1, value.lastIndexOf(']'))).map((item) => readScalar(item)).filter((item) => item.length > 0);
  }

  if (value.startsWith('{')) {
    const labels = [];
    for (const part of splitFlow(value.slice(1, value.lastIndexOf('}')))) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const key = readScalar(part.slice(0, colon));
      const item = readScalar(part.slice(colon + 1));
      if (key === 'labels') labels.push(...readLabelsFromText(item));
      else if (key === 'group') labels.push(item);
    }
    return labels;
  }

  return [readScalar(value)];
}

/** Read the labels out of a block of lines. */
function readLabelsFromBlock(block) {
  if (block.length === 0) return [];
  const first = readKey(block[0].text);
  if (first && first.isItem) {
    // A sequence of labels. An item may itself be a mapping that carries a
    // group and a set of labels.
    const labels = [];
    for (const entry of block) {
      const key = readKey(entry.text);
      if (!key) continue;
      if (!key.isItem) continue;
      if (key.value.length > 0 && !key.value.startsWith('#')) {
        labels.push(...readLabelsFromText(key.value));
        continue;
      }
      labels.push(...readLabelsFromBlock(readNestedBlock(block, entry)));
    }
    return labels;
  }

  // A mapping that carries a group and a set of labels.
  const labels = [];
  for (const entry of block) {
    const key = readKey(entry.text);
    if (!key || key.isItem) continue;
    if (key.name === 'labels') {
      if (key.value.length > 0 && !key.value.startsWith('#')) {
        labels.push(...readLabelsFromText(key.value));
        continue;
      }
      labels.push(...readLabelsFromBlock(readNestedBlock(block, entry)));
    }
    if (key.name === 'group' && key.value.length > 0 && !key.value.startsWith('#')) {
      labels.push(readScalar(key.value));
    }
  }
  return labels;
}

/** Read every runner label a workflow file names. */
function readWorkflowLabels(filePath, root) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const file = toPosix(relative(root, filePath));
  const runners = [];

  for (const job of readJobs(lines)) {
    const runner = readRunner(job);
    const labels = runner === null ? [] : runner.inline !== undefined
      ? readLabelsFromText(runner.inline)
      : readLabelsFromBlock(runner.block);
    runners.push({
      file,
      job: job.name,
      line: runner === null ? job.line : runner.line,
      labels,
      named: runner !== null,
    });
  }

  return runners;
}

// ---------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------

/** Read the file that maps a label to the machine that answers it. */
function readConfig(path) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { error: `the configuration file "${basename(path)}" cannot be read` };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: `the configuration file "${basename(path)}" is not valid JSON` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `the configuration file "${basename(path)}" does not hold an object` };
  }

  const labels = parsed.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    return { error: `the configuration file "${basename(path)}" has no "labels" object` };
  }

  const machines = new Map();
  for (const [label, value] of Object.entries(labels)) {
    if (typeof value === 'string') {
      machines.set(label, value);
      continue;
    }
    if (value && typeof value === 'object' && typeof value.machine === 'string') {
      machines.set(label, value.machine);
      continue;
    }
    return { error: `the configuration file names no machine for the label "${label}"` };
  }

  const defaultLabel = typeof parsed.default === 'string' ? parsed.default : null;
  return { machines, defaultLabel, path };
}

/** Find the configuration file to read. */
function resolveConfigPath(repo, given) {
  if (given) return resolve(given);
  const inRepository = resolve(repo, 'scripts', EXAMPLE_CONFIG_NAME);
  if (existsSync(inRepository)) return inRepository;
  const beside = resolve(fileURLToPath(import.meta.url), '..', EXAMPLE_CONFIG_NAME);
  if (existsSync(beside)) return beside;
  return null;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** True when the label names a floating tag rather than a fixed version. */
function isFloatingTag(label) {
  const marker = label.lastIndexOf(':');
  if (marker === -1) return false;
  const tag = label.slice(marker + 1);
  if (tag.length === 0) return false;
  return !EXACT_VERSION.test(tag);
}

/** True when the label is written as an expression rather than as a name. */
function isExpression(label) {
  return /^\$\{\{[\s\S]*\}\}$/.test(label.trim());
}

/**
 * Check every runner label a workflow names against the configured
 * machines, and check every job that names no runner at all.
 */
function checkWorkflows(runners, config, findings) {
  for (const runner of runners) {
    if (!runner.named) {
      const used = config.defaultLabel === null
        ? 'the default of the platform, which the configuration does not describe'
        : `the default "${config.defaultLabel}"`;
      findings.push({
        kind: 'no-runner',
        file: runner.file,
        line: runner.line,
        job: runner.job,
        message: `the job "${runner.job}" names no runner, so it will use ${used}`,
      });
      continue;
    }

    if (runner.labels.length === 0) {
      findings.push({
        kind: 'no-runner',
        file: runner.file,
        line: runner.line,
        job: runner.job,
        message: `the job "${runner.job}" names no runner label, so it will use the default of the platform`,
      });
      continue;
    }

    for (const label of runner.labels) {
      if (isExpression(label)) {
        findings.push({
          kind: 'dynamic-label',
          file: runner.file,
          line: runner.line,
          job: runner.job,
          label,
          message: `the job "${runner.job}" names its runner as an expression, so it cannot be checked against the configured machines`,
        });
        continue;
      }

      if (!config.machines.has(label)) {
        findings.push({
          kind: 'unknown-label',
          file: runner.file,
          line: runner.line,
          job: runner.job,
          label,
          message: `the job "${runner.job}" names the label "${label}" and no configured machine answers it`,
        });
      }

      if (isFloatingTag(label)) {
        findings.push({
          kind: 'floating-tag',
          file: runner.file,
          line: runner.line,
          job: runner.job,
          label,
          message:
            `the job "${runner.job}" names the label "${label}" by a floating tag rather than by a ` +
            'version, so the runner can change under the workflow without anyone editing it',
        });
      }
    }
  }

  // The default of the configuration has to be a label the configuration
  // answers, or a job that names no runner lands nowhere.
  if (config.defaultLabel !== null && !config.machines.has(config.defaultLabel)) {
    findings.push({
      kind: 'unknown-default',
      file: config.path,
      line: 1,
      job: null,
      label: config.defaultLabel,
      message: `the default "${config.defaultLabel}" is not one of the configured labels, so a job that names no runner has no default to land on`,
    });
  }
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/** Write a file into a throwaway repository. */
function writeFixture(root, name, content) {
  const path = join(root, name);
  const folder = dirname(path);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

/** The configuration a throwaway repository is checked against. */
const FIXTURE_CONFIG = [
  '{',
  '  "version": 1,',
  '  "default": "build-pool",',
  '  "labels": {',
  '    "build-pool": { "machine": "machine-01", "kind": "group" },',
  '    "build-pool:2024.06.1": { "machine": "machine-01", "kind": "pinned" },',
  '    "test-pool": { "machine": "machine-02", "kind": "group" }',
  '  }',
  '}',
  '',
].join('\n');

/** Build a throwaway repository and return its path. */
function createFixtureRepository() {
  return mkdtempSync(join(tmpdir(), 'check-runners-self-test-'));
}

/** Write a workflow file into a throwaway repository. */
function writeWorkflow(root, name, content) {
  return writeFixture(root, join('.github', 'workflows', name), content);
}

/** The cases of the self-test: each one builds a repository and looks for a finding. */
function selfTestCases() {
  return [
    {
      name: 'a workflow that names a label no machine answers',
      must: 'the unknown label must be reported',
      build(root) {
        writeWorkflow(root, 'retired.yml', [
          'name: retired',
          '',
          'on:',
          '  push:',
          '',
          'jobs:',
          '  build:',
          '    runs-on: retired-pool',
          '    steps:',
          '      - run: echo hello',
          '',
        ].join('\n'));
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'unknown-label' && finding.label === 'retired-pool'),
    },
    {
      name: 'a workflow that names a runner by a floating tag',
      must: 'the floating tag must be reported',
      build(root) {
        writeWorkflow(root, 'floating.yml', [
          'name: floating',
          '',
          'on:',
          '  push:',
          '',
          'jobs:',
          '  build:',
          '    runs-on: build-pool:latest',
          '    steps:',
          '      - run: echo hello',
          '',
        ].join('\n'));
      },
      expect: (findings) => findings.some((finding) => finding.kind === 'floating-tag' && finding.label === 'build-pool:latest'),
    },
    {
      name: 'a job that names no runner',
      must: 'the missing runner and the default it will use must be reported',
      build(root) {
        writeWorkflow(root, 'silent.yml', [
          'name: silent',
          '',
          'on:',
          '  push:',
          '',
          'jobs:',
          '  build:',
          '    steps:',
          '      - run: echo hello',
          '',
        ].join('\n'));
      },
      expect: (findings) => {
        const finding = findings.find((item) => item.kind === 'no-runner');
        if (!finding) return false;
        // The finding has to name the default the job will land on.
        return finding.message.includes('build-pool');
      },
    },
    {
      name: 'a healthy repository',
      must: 'nothing must be reported',
      build(root) {
        writeWorkflow(root, 'good.yml', [
          'name: good',
          '',
          'on:',
          '  push:',
          '',
          'jobs:',
          '  build:',
          '    runs-on: build-pool',
          '    steps:',
          '      - run: echo hello',
          '  test:',
          '    runs-on:',
          '      - test-pool',
          '      - build-pool:2024.06.1',
          '    steps:',
          '      - run: echo hello',
          '',
        ].join('\n'));
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
      writeFixture(root, join('scripts', EXAMPLE_CONFIG_NAME), FIXTURE_CONFIG);
      testCase.build(root);
      const result = checkRepository(root, {
        directory: DEFAULT_DIRECTORY,
        configPath: join(root, 'scripts', EXAMPLE_CONFIG_NAME),
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
    process.stdout.write('check-runners self-test: FAILED\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(`check-runners self-test: passed (${cases.length} cases)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Running the checker
// ---------------------------------------------------------------------------

/** List the workflow files of a repository. */
function listWorkflowFiles(repo, directory) {
  const files = [];
  const queue = [resolve(repo, directory)];
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
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(full);
    }
  }
  return files.sort();
}

/** Check a whole repository and return the findings. */
function checkRepository(repo, options) {
  const configPath = options.configPath ?? resolveConfigPath(repo, options.config);
  if (configPath === null) {
    return { error: `no configuration file was found, pass one with --config` };
  }
  if (!existsSync(configPath)) {
    return { error: `the configuration file "${basename(configPath)}" does not exist` };
  }

  const config = readConfig(configPath);
  if (config.error) return { error: config.error };
  // The findings name the configuration file the way the repository names it.
  config.path = toPosix(relative(repo, configPath));

  const runners = [];
  for (const filePath of listWorkflowFiles(repo, options.directory)) {
    runners.push(...readWorkflowLabels(filePath, repo));
  }

  const findings = [];
  checkWorkflows(runners, config, findings);
  return { findings };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Print the help text. */
function printUsage() {
  process.stdout.write(
    [
      'check-runners — check the runner labels the workflows of a repository name.',
      '',
      'Usage:',
      '  node scripts/check-runners.mjs [options]',
      '',
      'Options:',
      '  --repo <dir>      The repository to check. Default: the repository the',
      '                    script lives in.',
      '  --dir <path>      The directory that holds the workflow files.',
      '                    Default: .github/workflows.',
      '  --config <file>   The file that maps a label to the machine that',
      '                    answers it. Default: scripts/runners.example.json of',
      '                    the repository, or the example that sits next to this',
      '                    script.',
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
      'The checker never reaches a machine and never runs a workflow. It reads',
      'the configuration file and the workflow files, and nothing else.',
      '',
    ].join('\n'),
  );
}

/** Read the command line. */
function parseArguments(argv) {
  const options = {
    repo: null,
    directory: DEFAULT_DIRECTORY,
    config: null,
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
    else if (argument === '--repo' || argument === '--dir' || argument === '--config') {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        process.stderr.write(`check-runners: the option "${argument}" needs a value\n`);
        return null;
      }
      if (argument === '--repo') options.repo = value;
      else if (argument === '--dir') options.directory = value;
      else options.config = value;
    } else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length);
    else if (argument.startsWith('--dir=')) options.directory = argument.slice('--dir='.length);
    else if (argument.startsWith('--config=')) options.config = argument.slice('--config='.length);
    else {
      process.stderr.write(`check-runners: the option "${argument}" is not known\n`);
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
    process.stdout.write(`${finding.file}:${finding.line}: [${finding.kind}] ${finding.message}\n`);
  }
  if (!options.quiet) {
    const files = new Set(findings.map((finding) => finding.file)).size;
    process.stdout.write(`check-runners: ${findings.length} finding(s) in ${files} file(s)\n`);
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
    process.stderr.write(`check-runners: the directory "${repo}" does not exist\n`);
    return 2;
  }

  const result = checkRepository(repo, options);
  if (result.error) {
    process.stderr.write(`check-runners: ${result.error}\n`);
    return 2;
  }

  report(result.findings, options);
  return result.findings.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
