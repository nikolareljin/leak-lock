package com.leaklock.intellij.services

import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

object ProcessRunner {
    data class Result(val exitCode: Int, val stdout: String, val stderr: String)

    fun run(
        command: List<String>,
        workDir: java.io.File? = null,
        timeoutMs: Long = 0L,
        env: Map<String, String> = emptyMap()
    ): Result {
        val pb = ProcessBuilder(command)
        if (workDir != null) pb.directory(workDir)
        if (env.isNotEmpty()) pb.environment().putAll(env)
        pb.redirectErrorStream(false)

        val proc = pb.start()
        val stdout = StringBuilder()
        val stderr = StringBuilder()

        val outThread = Thread {
            BufferedReader(InputStreamReader(proc.inputStream)).use { r ->
                var line: String?
                while (r.readLine().also { line = it } != null) stdout.appendLine(line)
            }
        }
        val errThread = Thread {
            BufferedReader(InputStreamReader(proc.errorStream)).use { r ->
                var line: String?
                while (r.readLine().also { line = it } != null) stderr.appendLine(line)
            }
        }
        outThread.start(); errThread.start()

        if (timeoutMs > 0) proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS) else proc.waitFor()
        outThread.join(200)
        errThread.join(200)
        return Result(proc.exitValue(), stdout.toString(), stderr.toString())
    }

    fun shell(command: String, workDir: java.io.File? = null, timeoutMs: Long = 0L): Result {
        val isWindows = System.getProperty("os.name").startsWith("Windows", true)
        val cmd = if (isWindows) listOf("cmd", "/c", command) else listOf("/bin/sh", "-lc", command)
        return run(cmd, workDir, timeoutMs)
    }
}

