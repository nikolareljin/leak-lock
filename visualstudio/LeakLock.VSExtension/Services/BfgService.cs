using LeakLock.VSExtension.Models;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace LeakLock.VSExtension.Services
{
    internal class BfgService
    {
        private const string BfgUrl = "https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar";

        public async Task RunCleanupAsync(string repoDir, List<Finding> findings)
        {
            if (string.IsNullOrWhiteSpace(repoDir) || !Directory.Exists(repoDir))
                throw new ArgumentException("Invalid repository directory.");
            if (findings == null || findings.Count == 0)
                throw new ArgumentException("No findings provided.");

            var replacementsPath = Path.Combine(repoDir, "leak-lock-replacements.txt");
            var bfgJarPath = await EnsureBfgAsync();

            try
            {
                // Generate replacements file: one line per secret: pattern==>replacement
                var lines = findings
                    .Select(f => (pattern: EscapeForBfg(f.Preview), replacement: "***REMOVED***"))
                    .Distinct()
                    .Select(x => $"{x.pattern}==>{x.replacement}");
                File.WriteAllLines(replacementsPath, lines);

                // Run BFG
                var (code, stdout, stderr) = await ProcessRunner.RunAsync("cmd.exe", $"/c java -jar \"{bfgJarPath}\" --replace-text \"{replacementsPath}\"", workingDirectory: repoDir, timeoutMs: 600_000);
                if (code != 0)
                    throw new InvalidOperationException($"BFG failed: {stderr}\n{stdout}");

                // Git cleanup
                await ProcessRunner.RunAsync("cmd.exe", "/c git reflog expire --expire=now --all", workingDirectory: repoDir, timeoutMs: 60_000);
                await ProcessRunner.RunAsync("cmd.exe", "/c git gc --prune=now --aggressive", workingDirectory: repoDir, timeoutMs: 300_000);
            }
            finally
            {
                try { if (File.Exists(replacementsPath)) File.Delete(replacementsPath); } catch { }
            }
        }

        private static string EscapeForBfg(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            // Keep it simple: BFG replace-text takes plain string or regex. Default to literal string by escaping backslashes.
            return s.Replace("\\", "\\\\");
        }

        private static async Task<string> EnsureBfgAsync()
        {
            var dest = Path.Combine(Path.GetTempPath(), "bfg.jar");
            if (File.Exists(dest)) return dest;

            // Try to download using powershell's Invoke-WebRequest to avoid extra dependencies
            var ps = $"-NoProfile -ExecutionPolicy Bypass -Command \"try { Invoke-WebRequest -UseBasicParsing -Uri '{BfgUrl}' -OutFile '{dest}'; exit 0 } catch { exit 1 }\"";
            var (code, _, _) = await ProcessRunner.RunAsync("powershell", ps, timeoutMs: 300_000);
            if (code != 0)
                throw new InvalidOperationException("Failed to download BFG jar. Please ensure network access and try again.");
            return dest;
        }
    }
}

