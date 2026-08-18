#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const versionPath = path.join(root, 'VERSION');
const packagePath = path.join(root, 'package.json');
const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');
const changelogPath = path.join(root, 'CHANGELOG.md');
const outputPath = path.join(root, '.release-notes.md');

const args = new Set(process.argv.slice(2));
const syncChangelog = args.has('--sync-changelog');

if (!fs.existsSync(versionPath)) {
  throw new Error('VERSION is missing.');
}

const version = fs.readFileSync(versionPath, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('VERSION must contain a semantic version like 0.9.0.');
}

const packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
if (packageVersion !== version) {
  throw new Error(`VERSION (${version}) does not match package.json (${packageVersion}).`);
}

if (!fs.existsSync(releaseNotesPath)) {
  throw new Error('RELEASE_NOTES.md is missing.');
}

const releaseNotes = fs.readFileSync(releaseNotesPath, 'utf8').trim();
const escapedVersion = version.replace(/\./g, '\\.');
const titlePattern = new RegExp(`^#\\s+Release notes,\\s+v?${escapedVersion}(?:\\s|$)`, 'i');
if (!titlePattern.test(releaseNotes)) {
  throw new Error(`RELEASE_NOTES.md must start with "# Release notes, v${version}".`);
}

const body = releaseNotes.replace(/^#\s*/, '## ');
fs.writeFileSync(outputPath, `${body}\n`, 'utf8');
console.log(`Wrote release notes for v${version} to ${path.relative(root, outputPath)}.`);

if (syncChangelog) {
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const headingPattern = /^## .*\bv?(\d+\.\d+\.\d+)\b.*$/gm;
  const headings = [...changelog.matchAll(headingPattern)];
  const existingIndex = headings.findIndex((match) => match[1] === version);
  const date = new Date().toISOString().slice(0, 10);
  const changelogSection = body.replace(/^## Release notes, v?[^\n]+/, `## ${date} - v${version}`);

  let nextChangelog;
  if (existingIndex === -1) {
    const firstHeading = headings[0];
    if (!firstHeading) {
      nextChangelog = `# Change Log\n\n${changelogSection}\n`;
    } else {
      nextChangelog = `${changelog.slice(0, firstHeading.index)}${changelogSection}\n\n${changelog.slice(firstHeading.index)}`;
    }
  } else {
    const start = headings[existingIndex].index;
    const nextHeading = headings[existingIndex + 1];
    const end = nextHeading ? nextHeading.index : changelog.length;
    nextChangelog = `${changelog.slice(0, start)}${changelogSection}\n\n${changelog.slice(end).replace(/^\n+/, '')}`;
  }

  fs.writeFileSync(changelogPath, nextChangelog, 'utf8');
  console.log(`Synced v${version} release notes into CHANGELOG.md.`);
}
