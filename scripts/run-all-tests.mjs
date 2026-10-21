#!/usr/bin/env node
// The test runner of this repository.
//
// Every tool in scripts/ carries its own self-test, which proves that each of
// its rules catches the case it is meant to catch and does not fire on the
// case it must leave alone. This runner executes all of them and reports one
// summary, so that a single command tells you whether the repository is sound.
//
// It runs the tools as separate processes, because that is how they are used,
// and it does not depend on anything outside the Node standard library.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The runner lives beside the tools it runs, so the directory it reads is this
// one and not a child of it.
const scriptsDir = here;

// The tools that carry a self-test. A tool is picked up by its file name, so a
// new tool joins the suite by being written with a --self-test mode.
const TOOL_PATTERN = /^[a-z][a-z0-9-]*\.mjs$/;

function listTools() {
  let entries = [];
  try {
    entries = readdirSync(scriptsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => TOOL_PATTERN.test(name))
    .filter((name) => name !== 'run-all-tests.mjs')
    .filter((name) => name !== 'install-hooks.mjs')
    .sort();
}

function runSelfTest(tool) {
  const path = join(scriptsDir, tool);
  try {
    const output = execFileSync(process.execPath, [path, '--self-test'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const last = output.trim().split('\n').filter(Boolean).pop() || 'passed';
    return { tool, ok: true, message: last.trim() };
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : '';
    const stdout = error.stdout ? String(error.stdout) : '';
    const detail = (stderr.trim() || stdout.trim() || error.message)
      .split('\n')
      .filter(Boolean)
      .pop();
    return { tool, ok: false, message: detail || 'the self-test failed' };
  }
}

function main() {
  const tools = listTools();
  if (tools.length === 0) {
    console.error('no tools with a self-test were found in scripts/');
    process.exit(1);
  }

  console.log(`running the self-test of ${tools.length} tool(s)\n`);
  let failed = 0;
  for (const tool of tools) {
    const result = runSelfTest(tool);
    if (result.ok) {
      console.log(`  pass  ${result.tool} — ${result.message}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${result.tool} — ${result.message}`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.log(`${failed} of ${tools.length} self-test(s) failed`);
    process.exit(1);
  }
  console.log(`all ${tools.length} self-test(s) passed`);
  process.exit(0);
}

main();
