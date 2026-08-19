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
const checkOnly = args.has('--check');

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateSemver(label, value) {
  if (!semverPattern.test(value)) {
    throw new Error(`${label} must be strict SemVer like 0.9.0, with no wildcards or ranges.`);
  }
}

function validateReleaseNotes(markdown) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(markdown)) {
    throw new Error('RELEASE_NOTES.md must not contain control characters.');
  }

  const rawHtmlPattern = /<!--|<![A-Za-z][^>\n]*>|<\?[A-Za-z][^>\n]*\?>|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?\/?>/;
  if (rawHtmlPattern.test(markdown)) {
    throw new Error('RELEASE_NOTES.md must not contain raw HTML.');
  }

  const executablePatterns = [
    { pattern: /`/, label: 'backticks' },
    { pattern: /\$\s*\(/, label: 'shell command substitution' },
    { pattern: /\$\s*\{/, label: 'template or workflow expression syntax' },
    { pattern: /(?:^|\s)(?:eval|Function|require|import)\s*\(/, label: 'JavaScript call syntax' },
    { pattern: /(?:^|\s)(?:process|globalThis)\s*\./, label: 'JavaScript global access' },
    { pattern: /(?:^|\s)(?:bash|sh|zsh|fish|powershell|pwsh|cmd(?:\.exe)?|node|npm|npx|python3?|ruby|perl|curl|wget|git|gh|pip)\s+[-./\w]/, label: 'command invocation syntax' },
    { pattern: /\s(?:&&|\|\||[;|])\s*/, label: 'shell control syntax' },
    { pattern: /\s>\s*\S/, label: 'shell output redirection syntax' },
    { pattern: /\s<(?![A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>)/, label: 'shell input redirection syntax' }
  ];

  for (const { pattern, label } of executablePatterns) {
    if (pattern.test(markdown)) {
      throw new Error(`RELEASE_NOTES.md must not contain ${label}.`);
    }
  }

  const unsafeTargetPattern = /^(?:javascript|data|vbscript):|^\/\//i;
  const unsafeLinkPattern = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(unsafeLinkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (unsafeTargetPattern.test(target)) {
      throw new Error('RELEASE_NOTES.md contains an unsafe markdown link target.');
    }
  }

  const autolinkPattern = /<([^<>\s]+)>/g;
  for (const match of markdown.matchAll(autolinkPattern)) {
    if (unsafeTargetPattern.test(match[1])) {
      throw new Error('RELEASE_NOTES.md contains an unsafe markdown autolink target.');
    }
  }

  const allowedSections = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
  let inSection = false;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (index === 0 || line.trim() === '') {
      continue;
    }
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (!allowedSections.has(heading[1].trim())) {
        throw new Error(`RELEASE_NOTES.md has unsupported section "${heading[1].trim()}".`);
      }
      inSection = true;
      continue;
    }
    if (line.startsWith('#')) {
      throw new Error('RELEASE_NOTES.md must use only top-level release title and allowed sections.');
    }
    if (!inSection || !line.startsWith('- ')) {
      throw new Error('RELEASE_NOTES.md content must be bullet items under allowed sections.');
    }
  }
}

if (checkOnly && syncChangelog) {
  throw new Error('--check cannot be combined with --sync-changelog.');
}

if (!fs.existsSync(versionPath)) {
  throw new Error('VERSION is missing.');
}

const version = fs.readFileSync(versionPath, 'utf8').trim();
validateSemver('VERSION', version);

const packageVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
validateSemver('package.json version', packageVersion);
if (packageVersion !== version) {
  throw new Error(`VERSION (${version}) does not match package.json (${packageVersion}).`);
}

if (!fs.existsSync(releaseNotesPath)) {
  throw new Error('RELEASE_NOTES.md is missing.');
}

const releaseNotes = fs.readFileSync(releaseNotesPath, 'utf8').trim();
const escapedVersion = escapeRegex(version);
const titlePattern = new RegExp(`^#\\s+Release notes,\\s+v?${escapedVersion}(?:\\s|$)`, 'i');
if (!titlePattern.test(releaseNotes)) {
  throw new Error(`RELEASE_NOTES.md must start with "# Release notes, ${version}" or "# Release notes, v${version}".`);
}
validateReleaseNotes(releaseNotes);

const body = releaseNotes.replace(/^#\s+Release notes,\s+v?[^\n]+/i, `## Release notes, v${version}`);

if (checkOnly) {
  console.log('Release sources are valid.');
  process.exit(0);
}

fs.writeFileSync(outputPath, `${body}\n`, 'utf8');
console.log(`Wrote release notes for v${version} to ${path.relative(root, outputPath)}.`);

if (syncChangelog) {
  if (!fs.existsSync(changelogPath)) {
    throw new Error('CHANGELOG.md is missing.');
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const headingPattern = /^## .*\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b.*$/gm;
  const headings = [...changelog.matchAll(headingPattern)];
  const existingIndex = headings.findIndex((match) => match[1] === version);
  const firstHeading = headings[0];
  const separator = firstHeading ? (firstHeading[0].match(/\s+([^\d\w\s]+)\s+v?\d+\.\d+\.\d+/u)?.[1] || '-') : '-';
  const date = new Date().toISOString().slice(0, 10);
  const changelogBody = body.replace(/^## /gm, '### ');
  const changelogSection = changelogBody.replace(/^### Release notes, v[^\n]+/, `## ${date} ${separator} v${version}`);

  let nextChangelog;
  if (existingIndex === -1) {
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
