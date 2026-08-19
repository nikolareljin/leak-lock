#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const defaultRoot = path.resolve(__dirname, '..');

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// RELEASE_NOTES.md is consumed in exactly three places: as the message of an
// annotated git tag (`git tag -F`), as the body of a GitHub Release, and as a
// CHANGELOG.md section. None of them hand the text to a shell or to a
// JavaScript evaluator, so banning shell metacharacters or command names buys
// no safety and costs real release notes: "- Values < 10 are ignored.",
// "- Support Node >= 22." and "- Rewrite history with git filter-repo." are all
// legitimate, and all were rejected by such rules. What the consumers do is
// render Markdown and carry the text through workflow files, so the guards here
// are scoped to that: no control characters, no raw HTML, no unsafe link or
// autolink targets, and no syntax a shell or GitHub Actions would expand if the
// text ever landed inside a `run:` block or a `${{ }}` expression.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// URI schemes are case-insensitive, so <HTTPS://example.com> is a perfectly
// ordinary autolink. Matching only lowercase left it unstripped, and the raw
// HTML check then rejected it as an unsupported scheme.
const SAFE_AUTOLINK = /<(?:https?:\/\/[^<>\s]+|mailto:[^<>\s]+|[^<>\s@]+@[^<>\s@.]+(?:\.[^<>\s@.]+)+)>/gi;
const UNSAFE_TARGET = /^(?:javascript|data|vbscript|file|blob|filesystem):|^\/\//i;
const AUTOLINK_SCHEME = /^<[A-Za-z][A-Za-z0-9+.-]*:/;
const ALLOWED_SECTIONS = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateSemver(label, value) {
  if (!semverPattern.test(value)) {
    throw new Error(`${label} must be strict SemVer like 0.9.0, with no wildcards or ranges.`);
  }
}

// A Markdown renderer decodes entity and percent escapes before it uses the
// href, so `&#106;avascript:` and `%6Aavascript:` are the same link as
// `javascript:`. Comparing the raw text against the scheme list would have read
// all three as different.
function normalizeTarget(raw) {
  let value = raw.trim().replace(/^<+/, '').replace(/>+$/, '');
  value = value.replace(/&#x([0-9a-fA-F]{1,6});?/g, (match, hex) => codePoint(parseInt(hex, 16), match));
  value = value.replace(/&#(\d{1,7});?/g, (match, dec) => codePoint(parseInt(dec, 10), match));
  try {
    value = decodeURIComponent(value);
  } catch {
    // A stray '%' is not an escape; the undecoded text is still worth checking.
  }
  return value.replace(/\s/g, '');
}

function codePoint(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : fallback;
}

function validateReleaseNotes(markdown) {
  if (CONTROL_CHARACTERS.test(markdown)) {
    throw new Error('RELEASE_NOTES.md must not contain control characters.');
  }

  const interpolationPatterns = [
    { pattern: /`/, label: 'backticks' },
    { pattern: /\$\s*\(/, label: 'shell command substitution' },
    { pattern: /\$\s*\{/, label: 'template or workflow expression syntax' }
  ];

  for (const { pattern, label } of interpolationPatterns) {
    if (pattern.test(markdown)) {
      throw new Error(`RELEASE_NOTES.md must not contain ${label}.`);
    }
  }

  // The target is captured up to the first whitespace or closing paren rather
  // than by matching a whole well-formed link, so `[x](  javascript:alert(1))`
  // is inspected instead of skipped: requiring the target to sit flush against
  // the opening paren let a single leading space walk past this check.
  const linkTargetPattern = /!?\[[^\]\n]*\]\(\s*([^)\s]*)/g;
  for (const match of markdown.matchAll(linkTargetPattern)) {
    if (UNSAFE_TARGET.test(normalizeTarget(match[1]))) {
      throw new Error('RELEASE_NOTES.md contains an unsafe markdown link target.');
    }
  }

  // A link reference definition carries a target too, and `[ref]: javascript:...`
  // inside a bullet is a definition CommonMark honours, so `[ref]` elsewhere in
  // the notes renders as that link. The inline-link pattern above never sees it,
  // because the target follows `]:` rather than `](`.
  const referenceTargetPattern = /\[[^\]\n]*\]:\s*(\S+)/g;
  for (const match of markdown.matchAll(referenceTargetPattern)) {
    if (UNSAFE_TARGET.test(normalizeTarget(match[1]))) {
      throw new Error('RELEASE_NOTES.md contains an unsafe markdown link target.');
    }
  }

  const autolinkPattern = /<([^<>\s]+)>/g;
  for (const match of markdown.matchAll(autolinkPattern)) {
    if (UNSAFE_TARGET.test(normalizeTarget(match[1]))) {
      throw new Error('RELEASE_NOTES.md contains an unsafe markdown autolink target.');
    }
  }

  // Raw HTML is detected by removing the autolinks that are allowed and then
  // rejecting any `<` that still introduces a tag, comment, declaration or
  // processing instruction. One rule covers `<script>`, `</script>`,
  // `<svg/onload=...>`, `<!-- ... -->`, `<!DOCTYPE ...>`, `<?xml ... ?>` and
  // tags split across any number of lines, which a `[^>\n]*` tag pattern cannot.
  // Comparisons such as `< 10`, `<100 ms` and `<=` are left alone.
  const withoutSafeAutolinks = markdown.replace(SAFE_AUTOLINK, '');
  const rawMarkup = withoutSafeAutolinks.match(/<[A-Za-z!/?][^\n]{0,60}/);
  if (rawMarkup) {
    if (AUTOLINK_SCHEME.test(rawMarkup[0])) {
      throw new Error('RELEASE_NOTES.md may only autolink http, https and mailto targets.');
    }
    throw new Error('RELEASE_NOTES.md must not contain raw HTML.');
  }

  let inSection = false;
  let bullets = 0;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (index === 0 || line.trim() === '') {
      continue;
    }
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (!ALLOWED_SECTIONS.has(heading[1].trim())) {
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
    bullets += 1;
  }

  // A title-only file passed every rule above and produced an empty annotated
  // tag message and an empty GitHub Release body.
  if (bullets === 0) {
    throw new Error('RELEASE_NOTES.md must list at least one bullet under an allowed section.');
  }
}

function readReleaseSources(root) {
  const versionPath = path.join(root, 'VERSION');
  const packagePath = path.join(root, 'package.json');
  const releaseNotesPath = path.join(root, 'RELEASE_NOTES.md');

  if (!fs.existsSync(versionPath)) {
    throw new Error('VERSION is missing.');
  }

  if (!fs.existsSync(packagePath)) {
    throw new Error('package.json is missing.');
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
  const titlePattern = new RegExp(`^#\\s+Release notes,\\s+v?${escapeRegex(version)}(?:\\s|$)`, 'i');
  if (!titlePattern.test(releaseNotes)) {
    throw new Error(`RELEASE_NOTES.md must start with "# Release notes, ${version}" or "# Release notes, v${version}".`);
  }
  validateReleaseNotes(releaseNotes);

  const body = releaseNotes.replace(/^#\s+Release notes,\s+v?[^\n]+/i, `## Release notes, v${version}`);
  return { version, body };
}

function writeChangelog(root, version, body, { force }) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    throw new Error('CHANGELOG.md is missing.');
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const headingPattern = /^## .*\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b.*$/gm;
  const headings = [...changelog.matchAll(headingPattern)];
  const existingIndex = headings.findIndex((match) => match[1] === version);

  // A CHANGELOG section gets edited after it is generated: v0.9.0's entry is
  // long-form prose that RELEASE_NOTES.md cannot express, and replacing it with
  // the short bullets is a silent, unrecoverable loss. Overwriting is a
  // deliberate act, not the default one.
  if (existingIndex !== -1 && !force) {
    throw new Error(`CHANGELOG.md already has a v${version} section. Re-run with --force to replace it, or edit CHANGELOG.md directly.`);
  }

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
}

function parseArgs(argv) {
  const options = { root: defaultRoot, checkOnly: false, sync: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.checkOnly = true;
    } else if (arg === '--sync-changelog') {
      options.sync = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a directory.');
      }
      options.root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return options;
}

// --root exists so the tests can drive the generator against a fixture
// directory. They used to overwrite the repository's own RELEASE_NOTES.md and
// restore it in a finally block, which left the file corrupted whenever a run
// was interrupted.
function main(argv) {
  const options = parseArgs(argv);
  if (options.checkOnly && options.sync) {
    throw new Error('--check cannot be combined with --sync-changelog.');
  }
  if (options.force && !options.sync) {
    throw new Error('--force only applies to --sync-changelog.');
  }

  const { root } = options;
  const { version, body } = readReleaseSources(root);

  if (options.checkOnly) {
    console.log('Release sources are valid.');
    return;
  }

  // CHANGELOG.md is written before .release-notes.md so a refused overwrite
  // leaves no generated file behind to suggest the run succeeded.
  if (options.sync) {
    writeChangelog(root, version, body, { force: options.force });
    console.log(`Synced v${version} release notes into CHANGELOG.md.`);
  }

  const outputPath = path.join(root, '.release-notes.md');
  fs.writeFileSync(outputPath, `${body}\n`, 'utf8');
  console.log(`Wrote release notes for v${version} to ${path.relative(root, outputPath)}.`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { validateReleaseNotes, validateSemver, readReleaseSources, main };
