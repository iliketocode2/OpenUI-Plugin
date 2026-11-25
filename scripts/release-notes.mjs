#!/usr/bin/env node
// Prints the CHANGELOG section for a release tag, after checking the tag matches package.json.
//   node scripts/release-notes.mjs v0.2.0 > notes.md
// Fails when the tag is not v<package.json version>, or CHANGELOG.md has no non-empty "## <version>" section, so a
// release cannot go out with the wrong version or without notes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? '';
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (tag !== `v${version}`) fail(`The tag "${tag}" does not match package.json, whose version is ${version}. Tag the release v${version}, or bump the version first.`);

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "## 0.2.0", "## 0.2.0 — 2026-12-01", "## [0.2.0] - 2026-12-01"
const start = lines.findIndex((l) => new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`).test(l));
if (start === -1) fail(`CHANGELOG.md has no "## ${version}" section. Rename "## Unreleased" to "## ${version} — <date>" before tagging.`);
const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
const notes = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
if (!notes) fail(`The "## ${version}" section of CHANGELOG.md is empty.`);
process.stdout.write(`${notes}\n`);
