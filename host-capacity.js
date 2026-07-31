/**
 * Host capacity detection and scan execution strategy.
 *
 * Running three detection engines over a large git history is not free. On a capable
 * machine they should run concurrently; on a laptop with two cores they should not run
 * at all at the same time, and on a genuinely constrained host it is better to run one
 * lightweight engine well than three badly.
 *
 * The one rule that matters: **a downgrade is never silent**. Dropping an engine changes
 * the results, so every decision made here carries a human-readable reason that the
 * coverage report shows. Quietly scanning with less than the user asked for is the same
 * class of failure as a truncated result set.
 *
 * No `vscode` import, so the tier boundaries are unit-testable.
 */

const fs = require('fs');
const os = require('os');

// Below this, running two scanners concurrently means both swap.
const MIN_MEM_GB_FOR_PARALLEL = 8;
const MIN_CORES_FOR_PARALLEL = 6;
// Below this the machine struggles with one modern scanner, let alone several.
const CONSTRAINED_MEM_GB = 4;
const CONSTRAINED_CORES = 2;
// 1.0 means "every core already has a runnable process".
const BUSY_LOAD_PER_CORE = 1.5;

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Memory actually available to this process.
 *
 * os.totalmem() reports the *host's* memory even inside a container, so in a
 * devcontainer or Codespace — precisely where resources are tightest — it over-reports.
 * The cgroup limit is the real ceiling when one is set.
 *
 * @returns {{bytes: number, source: 'cgroup-v2'|'cgroup-v1'|'os'}}
 */
function detectMemoryLimit(readFile = defaultReadFile) {
    const hostBytes = os.totalmem();

    const v2 = readFile('/sys/fs/cgroup/memory.max');
    if (v2 !== null) {
        const trimmed = v2.trim();
        // "max" means unlimited, i.e. fall back to the host figure.
        if (trimmed && trimmed !== 'max') {
            const bytes = Number(trimmed);
            if (Number.isFinite(bytes) && bytes > 0 && bytes < hostBytes) {
                return { bytes, source: 'cgroup-v2' };
            }
        }
    }

    const v1 = readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (v1 !== null) {
        const bytes = Number(v1.trim());
        // cgroup v1 uses an enormous sentinel rather than a keyword for "unlimited".
        if (Number.isFinite(bytes) && bytes > 0 && bytes < hostBytes) {
            return { bytes, source: 'cgroup-v1' };
        }
    }

    return { bytes: hostBytes, source: 'os' };
}

function defaultReadFile(path) {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/**
 * A snapshot of what this machine can reasonably do right now.
 */
function describeHost(overrides = {}) {
    const cpus = Number.isFinite(overrides.cpus)
        ? overrides.cpus
        : (os.cpus() || []).length || 1;

    const memory = overrides.memoryBytes !== undefined
        ? { bytes: overrides.memoryBytes, source: overrides.memorySource || 'os' }
        : detectMemoryLimit(overrides.readFile);

    const platform = overrides.platform || os.platform();

    // os.loadavg() returns [0, 0, 0] on Windows rather than failing, so a Windows host
    // would otherwise always look completely idle.
    let loadPerCore = null;
    if (platform !== 'win32') {
        const load = Array.isArray(overrides.loadavg) ? overrides.loadavg : os.loadavg();
        if (Array.isArray(load) && Number.isFinite(load[0])) {
            loadPerCore = load[0] / Math.max(1, cpus);
        }
    }

    return {
        cpus,
        totalMemGb: memory.bytes / BYTES_PER_GB,
        memorySource: memory.source,
        platform,
        loadPerCore
    };
}

/**
 * Classify the host into a capacity tier.
 * @returns {'constrained'|'moderate'|'capable'}
 */
function classifyHost(host) {
    const busy = host.loadPerCore !== null && host.loadPerCore > BUSY_LOAD_PER_CORE;

    if (host.cpus <= CONSTRAINED_CORES || host.totalMemGb < CONSTRAINED_MEM_GB) {
        return 'constrained';
    }
    // A machine that is capable but currently saturated should not have three more
    // scanners piled onto it.
    if (busy) {
        return 'moderate';
    }
    if (host.cpus >= MIN_CORES_FOR_PARALLEL && host.totalMemGb >= MIN_MEM_GB_FOR_PARALLEL) {
        return 'capable';
    }
    return 'moderate';
}

/**
 * Engine cost, used to decide what survives on a constrained host.
 *
 * Gitleaks is the fallback because it is a single static binary with no container
 * runtime and no JVM, and because it is the only maintained engine with a full ruleset —
 * so the one engine left standing is also the one most likely to find something.
 */
const ENGINE_WEIGHT = Object.freeze({
    gitleaks: 1,     // static binary, no runtime
    trufflehog: 2,   // single binary, but verification adds network round-trips
    noseyparker: 3   // pulls and runs a container
});

const FALLBACK_ENGINE = 'gitleaks';

/**
 * Decide how to run the enabled engines.
 *
 * @param {object} options
 * @param {string[]} options.engines engine ids the user enabled
 * @param {object}   [options.host]  output of describeHost()
 * @param {string}   [options.mode]  'auto' | 'parallel' | 'sequential' | 'single'
 * @returns {{mode: string, engines: string[], dropped: string[], concurrency: number,
 *           tier: string, reason: string, host: object}}
 */
function chooseScanStrategy({ engines = [], host = describeHost(), mode = 'auto' } = {}) {
    const tier = classifyHost(host);
    const ordered = engines
        .slice()
        .sort((a, b) => (ENGINE_WEIGHT[a] || 9) - (ENGINE_WEIGHT[b] || 9));

    const hostSummary =
        `${host.cpus} core(s), ${host.totalMemGb.toFixed(1)} GB` +
        (host.memorySource !== 'os' ? ` (${host.memorySource} limit)` : '') +
        (host.loadPerCore !== null ? `, load ${host.loadPerCore.toFixed(2)}/core` : '');

    // An explicit choice is honoured. The user knows their machine better than a
    // heuristic does, and overriding them would be the same silent-downgrade problem
    // in the opposite direction.
    if (mode === 'parallel') {
        return {
            mode: 'parallel', engines: ordered, dropped: [],
            concurrency: Math.max(1, ordered.length), tier, host,
            reason: `Parallel execution requested explicitly (host: ${hostSummary}).`
        };
    }
    if (mode === 'sequential') {
        return {
            mode: 'sequential', engines: ordered, dropped: [], concurrency: 1, tier, host,
            reason: `Sequential execution requested explicitly (host: ${hostSummary}).`
        };
    }
    if (mode === 'single') {
        const kept = pickSingleEngine(ordered);
        return {
            mode: 'sequential', engines: kept, dropped: ordered.filter(e => !kept.includes(e)),
            concurrency: 1, tier, host,
            reason: `Single-engine execution requested explicitly (host: ${hostSummary}).`
        };
    }

    if (ordered.length <= 1) {
        return {
            mode: 'sequential', engines: ordered, dropped: [], concurrency: 1, tier, host,
            reason: `One engine enabled; nothing to parallelise (host: ${hostSummary}).`
        };
    }

    if (tier === 'constrained') {
        const kept = pickSingleEngine(ordered);
        const dropped = ordered.filter(e => !kept.includes(e));
        return {
            mode: 'sequential', engines: kept, dropped, concurrency: 1, tier, host,
            reason:
                `This host is constrained (${hostSummary}), so Leak Lock ran ${kept.join(', ')} only ` +
                `and skipped ${dropped.join(', ')}. Fewer engines means fewer findings — set ` +
                'leakLock.scan.executionMode to "sequential" or "parallel" to run them all anyway.'
        };
    }

    if (tier === 'moderate') {
        return {
            mode: 'sequential', engines: ordered, dropped: [], concurrency: 1, tier, host,
            reason:
                `Engines ran one at a time (host: ${hostSummary}). All enabled engines ran; ` +
                'only the scan takes longer.'
        };
    }

    return {
        mode: 'parallel', engines: ordered, dropped: [],
        // Leave headroom: the editor, the language servers and git all still need a core.
        concurrency: Math.max(2, Math.min(ordered.length, host.cpus - 2)),
        tier, host,
        reason: `Engines ran in parallel (host: ${hostSummary}).`
    };
}

function pickSingleEngine(ordered) {
    if (ordered.includes(FALLBACK_ENGINE)) {
        return [FALLBACK_ENGINE];
    }
    return ordered.slice(0, 1);
}

/**
 * Run tasks with a bounded number in flight.
 * A rejected task resolves to null in its slot rather than cancelling the rest — one
 * failing engine must not discard another engine's findings.
 */
async function runWithConcurrency(tasks, concurrency) {
    const limit = Math.max(1, Math.min(concurrency, tasks.length));
    const results = new Array(tasks.length);
    let next = 0;

    async function worker() {
        while (next < tasks.length) {
            const index = next++;
            try {
                results[index] = await tasks[index]();
            } catch (error) {
                results[index] = { error };
            }
        }
    }

    await Promise.all(Array.from({ length: limit }, worker));
    return results;
}

module.exports = {
    MIN_MEM_GB_FOR_PARALLEL,
    MIN_CORES_FOR_PARALLEL,
    CONSTRAINED_MEM_GB,
    CONSTRAINED_CORES,
    BUSY_LOAD_PER_CORE,
    ENGINE_WEIGHT,
    FALLBACK_ENGINE,
    detectMemoryLimit,
    describeHost,
    classifyHost,
    chooseScanStrategy,
    runWithConcurrency
};
