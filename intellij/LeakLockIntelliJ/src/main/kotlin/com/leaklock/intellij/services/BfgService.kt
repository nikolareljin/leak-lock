package com.leaklock.intellij.services

import com.leaklock.intellij.models.Finding
import java.io.File
import java.io.FileOutputStream
import java.net.URL

class BfgService {
    private val bfgUrl = "https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar"

    fun runCleanup(repoDir: String, findings: List<Finding>) {
        require(File(repoDir).exists()) { "Repository directory does not exist" }
        require(findings.isNotEmpty()) { "No findings provided" }

        val replacements = File(repoDir, "leak-lock-replacements.txt")
        val bfgJar = ensureBfg()

        try {
            // Build replacement rules (literal values; escape backslashes)
            val lines = findings
                .map { it.preview.replace("\\", "\\\\") + "==>***REMOVED***" }
                .distinct()
            replacements.writeText(lines.joinToString("\n"))

            // java -jar bfg.jar --replace-text leak-lock-replacements.txt
            val run = ProcessRunner.shell(
                command = "java -jar \"${bfgJar.absolutePath}\" --replace-text \"${replacements.absolutePath}\"",
                workDir = File(repoDir),
                timeoutMs = 600_000
            )
            if (run.exitCode != 0) error("BFG failed: ${run.stderr}\n${run.stdout}")

            // git cleanup
            ProcessRunner.shell("git reflog expire --expire=now --all", File(repoDir), 60_000)
            ProcessRunner.shell("git gc --prune=now --aggressive", File(repoDir), 300_000)
        } finally {
            try { replacements.delete() } catch (_: Throwable) {}
        }
    }

    private fun ensureBfg(): File {
        val dest = File(System.getProperty("java.io.tmpdir"), "bfg.jar")
        if (dest.exists()) return dest
        // Download via simple JDK API to avoid extra deps
        URL(bfgUrl).openStream().use { input ->
            FileOutputStream(dest).use { out ->
                input.copyTo(out)
            }
        }
        return dest
    }
}

