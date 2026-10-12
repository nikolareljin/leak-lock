#!/usr/bin/env node
/**
 * TEST-FIXTURE TOOLING ONLY. Run by hand to build test and screenshot fixtures; not
 * imported, required or executed by the extension, its tests, CI or any other tool.
 * See tools/fixtures/README.md. Excluded from the repository's own scans by
 * .gitleaks.toml and .foxguard.yml.
 *
 * Write SYNTHETIC insecure code for Foxguard to find, so the Code issues section can
 * be exercised and photographed for the documentation.
 *
 *   node tools/fixtures/seed-code-issues.js                 # new throwaway repo under $TMPDIR
 *   node tools/fixtures/seed-code-issues.js --into <repo>   # local commit in an existing repo
 *
 * Options
 *   --into <repo>   commit the samples on branch leaklock-fixture/code-issues of an
 *                   existing local repository instead of a new throwaway one
 *   --base <ref>    with --into: the commit to branch from (default HEAD)
 *   --reset         with --into: replace an existing leaklock-fixture/code-issues
 *
 * THIS TOOL NEVER TOUCHES A REMOTE. It does not push, fetch, clone, add or change a
 * remote, or create a repository anywhere but on this disk. Every git call goes
 * through runGit(), which refuses those subcommands and disables every transport
 * (protocol.allow=never). Publishing is a manual step: the tool prints the command,
 * and a person decides whether to run it.
 *
 * The samples are stored as plain strings, so this file itself carries no finding.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRANCH = 'leaklock-fixture/code-issues';
const DIR = 'leaklock-fixture/code';
const IDENTITY = {
    GIT_AUTHOR_NAME: 'Leak Lock Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Leak Lock Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
};

// Subcommands that reach, name or change a remote. Refused outright, whatever the
// arguments: a demo generator has no reason to talk to any server.
const FORBIDDEN = new Set([
    'push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'send-pack',
    'submodule', 'request-pull', 'archive', 'bundle', 'daemon', 'credential'
]);

function runGit(cwd, args) {
    const sub = args.find(arg => !arg.startsWith('-'));
    if (!sub || FORBIDDEN.has(sub)) {
        throw new Error(`refusing git ${sub || '(no subcommand)'}: this tool never touches a remote`);
    }
    return execFileSync('git', ['-c', 'protocol.allow=never', '-C', cwd, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

const HEADER = {
    py: '# Synthetic example for Leak Lock documentation. Intentionally insecure; never deploy.',
    js: '// Synthetic example for Leak Lock documentation. Intentionally insecure; never deploy.'
};

// Each line is chosen to trigger one Foxguard 0.14.0 rule. No credentials: those are
// tools/seed-fake-leaks.sh's job, and a value here would also trip the push gate.
const SAMPLES = {
    'app/reports.py': [
        HEADER.py,
        'import hashlib',
        'import pickle',
        'import subprocess',
        '',
        '',
        'def export_report(name):',
        '    subprocess.call("tar czf /tmp/" + name + ".tgz reports/", shell=True)',
        '',
        '',
        'def evaluate_filter(expression):',
        '    return eval(expression)',
        '',
        '',
        'def load_cached(blob):',
        '    return pickle.loads(blob)',
        '',
        '',
        'def checksum(data):',
        '    return hashlib.md5(data).hexdigest()',
        ''
    ].join('\n'),
    'app/queries.py': [
        HEADER.py,
        '',
        '',
        'def find_user(cursor, user_id):',
        '    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")',
        '    return cursor.fetchone()',
        ''
    ].join('\n'),
    'web/preview.js': [
        HEADER.js,
        'const { exec } = require("child_process");',
        '',
        'function showPreview(element, markup) {',
        '    element.innerHTML = markup;',
        '}',
        '',
        'function runFormula(text) {',
        '    return eval(text);',
        '}',
        '',
        'function thumbnail(file) {',
        '    exec("convert " + file + " -resize 64x64 thumb.png");',
        '}',
        '',
        'module.exports = { showPreview, runFormula, thumbnail };',
        ''
    ].join('\n')
};

function writeSamples(root) {
    for (const [relative, content] of Object.entries(SAMPLES)) {
        const file = path.join(root, DIR, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

function commitSamples(repo) {
    writeSamples(repo);
    runGit(repo, ['add', '--', DIR]);
    // The target's own commit hooks run. If one objects to deliberately insecure
    // code, the commit fails and nothing is written to history.
    runGit(repo, ['commit', '-q', '-m', 'fixture: synthetic insecure code for Foxguard']);
}

function parseArgs(argv) {
    const opts = { into: null, base: 'HEAD', reset: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--into') opts.into = argv[++i];
        else if (arg === '--base') opts.base = argv[++i];
        else if (arg === '--reset') opts.reset = true;
        else if (arg === '-h' || arg === '--help') opts.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (opts.into === undefined || opts.base === undefined) throw new Error('missing value for an option');
    return opts;
}

/** A new repository in a fresh temporary directory. No remote exists to push to. */
function createThrowawayRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'leaklock-demo-'));
    const repo = path.join(parent, 'demo-app');
    fs.mkdirSync(repo);
    runGit(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo-app\n\nSynthetic repository for Leak Lock documentation.\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-q', '-m', 'initial commit']);
    commitSamples(repo);
    return repo;
}

/** A local commit on its own branch of an existing repository. Nothing is published. */
function seedExistingRepo(target, { base, reset }) {
    const repo = runGit(path.resolve(target), ['rev-parse', '--show-toplevel']);
    if (path.resolve(repo) === path.resolve(__dirname, '..', '..')) {
        throw new Error('refusing to plant insecure code in the Leak Lock repository itself');
    }
    // Tracked changes only: the credential fixture leaves untracked fake secrets on
    // disk on purpose, and only the samples directory is ever staged.
    if (runGit(repo, ['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error(`${repo} has uncommitted changes; commit or stash them first`);
    }
    const exists = runGit(repo, ['branch', '--list', BRANCH]);
    if (exists && !reset) {
        throw new Error(`${BRANCH} already exists in ${repo}; pass --reset to replace it`);
    }
    const baseCommit = runGit(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
    runGit(repo, ['checkout', '-q', '-B', BRANCH, baseCommit]);
    commitSamples(repo);
    return repo;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n'));
        return;
    }
    if (!opts.into) {
        const repo = createThrowawayRepo();
        console.log(`Synthetic code issues written to a new local repository (no remote):\n  ${repo}\n`);
        console.log(`Scan it with Foxguard or Leak Lock, then delete the directory:\n  rm -rf "${path.dirname(repo)}"`);
        return;
    }
    const repo = seedExistingRepo(opts.into, opts);
    console.log(`Committed synthetic code issues on ${BRANCH} in:\n  ${repo}\n`);
    console.log('Nothing was pushed. To publish it, review the commit and push it yourself:');
    console.log(`  git -C "${repo}" show --stat ${BRANCH}`);
    console.log(`  git -C "${repo}" push origin ${BRANCH}`);
    console.log('\nTo undo locally:');
    console.log(`  git -C "${repo}" checkout -    # back to the previous branch`);
    console.log(`  git -C "${repo}" branch -D ${BRANCH}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`seed-code-issues: ${error.message}`);
        process.exit(2);
    }
}

module.exports = { runGit, FORBIDDEN, SAMPLES, BRANCH, DIR, createThrowawayRepo, seedExistingRepo };
