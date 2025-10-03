package com.leaklock.intellij.services

import com.google.gson.JsonArray
import com.google.gson.JsonParser
import com.leaklock.intellij.models.Finding
import java.io.File

class ScannerService {
    private val image = "ghcr.io/praetorian-inc/noseyparker:latest"

    fun installDependencies(progress: ((String) -> Unit)? = null) {
        progress?.invoke("Checking Docker…")
        ensureDocker()
        progress?.invoke("Pulling Nosey Parker image…")
        pullImage()
        progress?.invoke("Checking Java…")
        ensureJava()
    }

    fun scan(directory: String, progress: ((String) -> Unit)? = null): List<Finding> {
        require(File(directory).exists()) { "Directory does not exist" }
        ensureDocker()

        val datastore = File(System.getProperty("java.io.tmpdir"), ".noseyparker-temp-" + System.nanoTime())
        datastore.mkdirs()

        try {
            progress?.invoke("Initializing datastore…")
            runDocker("run --rm -v \"${datastore.absolutePath}:/datastore\" $image datastore init --datastore /datastore", 120_000)

            progress?.invoke("Scanning directory…")
            runDockerAllowFindings("run --rm -v \"$directory:/scan:ro\" -v \"${datastore.absolutePath}:/datastore\" $image scan --datastore /datastore /scan", 300_000)

            progress?.invoke("Generating report…")
            val report = runDocker("run --rm -v \"${datastore.absolutePath}:/datastore\" $image report --datastore /datastore --format json", 60_000)
            if (report.exitCode != 0) error("Report failed: ${report.stderr}")
            return parseFindings(report.stdout, directory)
        } finally {
            try { datastore.deleteRecursively() } catch (_: Throwable) {}
        }
    }

    private fun parseFindings(json: String, baseDir: String): List<Finding> {
        if (json.isBlank()) return emptyList()
        val arr = try { JsonParser.parseString(json).asJsonArray } catch (t: Throwable) { JsonArray() }
        val list = mutableListOf<Finding>()
        for (item in arr) {
            val obj = item.asJsonObject
            val rule = (obj.get("rule_name") ?: obj.get("rule"))?.asString ?: ""
            val matches = obj.getAsJsonArray("matches") ?: continue
            for (m in matches) {
                val mo = m.asJsonObject
                val prov = mo.getAsJsonArray("provenance")?.firstOrNull()?.asJsonObject
                val relPath = prov?.get("path")?.asString ?: ""
                val start = mo.getAsJsonObject("location")?.getAsJsonObject("source_span")?.getAsJsonObject("start")
                val line = start?.get("line")?.asInt ?: 0
                val preview = mo.getAsJsonObject("snippet")?.get("matching")?.asString ?: ""
                val abs = normalize(baseDir, relPath)
                list.add(Finding(rule, abs, line, preview.take(120)))
            }
        }
        return list
    }

    private fun ensureDocker() {
        val res = ProcessRunner.run(listOf("docker", "--version"), timeoutMs = 10_000)
        if (res.exitCode != 0) error("Docker is not available. Install/start Docker Desktop.")
    }

    private fun ensureJava() {
        val res = ProcessRunner.run(listOf("java", "-version"), timeoutMs = 10_000)
        if (res.exitCode != 0) error("Java is not available. Install a JRE for BFG.")
    }

    private fun pullImage() {
        ProcessRunner.run(listOf("docker", "pull", image), timeoutMs = 300_000)
    }

    private fun runDocker(args: String, timeout: Long) = ProcessRunner.shell("docker $args", timeoutMs = timeout)

    private fun runDockerAllowFindings(args: String, timeout: Long) {
        val res = runDocker(args, timeout)
        if (res.exitCode != 0 && res.exitCode != 2) {
            error("Scan failed (exit ${res.exitCode}): ${res.stderr}\n${res.stdout}")
        }
    }

    private fun normalize(base: String, relative: String): String {
        return try {
            val baseFile = File(base)
            val rel = File(relative)
            val file = if (rel.isAbsolute) rel else File(baseFile, relative)
            file.canonicalPath
        } catch (_: Throwable) {
            File(base, relative).absolutePath
        }
    }
}
