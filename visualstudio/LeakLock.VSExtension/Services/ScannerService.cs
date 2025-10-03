using LeakLock.VSExtension.Models;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace LeakLock.VSExtension.Services
{
    internal class ScannerService
    {
        private const string DockerImage = "ghcr.io/praetorian-inc/noseyparker:latest";

        public async Task InstallDependenciesAsync()
        {
            // Verify docker
            await EnsureDockerAsync();
            // Pull image
            await PullImageAsync();
            // Verify Java (BFG)
            await EnsureJavaAsync();
        }

        public async Task<ScanResult> ScanAsync(string directory)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
                throw new ArgumentException("Invalid directory.");

            await EnsureDockerAsync();

            var datastore = Path.Combine(Path.GetTempPath(), ".noseyparker-temp-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(datastore);

            try
            {
                // 1) init
                await RunDockerAsync($"run --rm -v \"{datastore}:/datastore\" {DockerImage} datastore init --datastore /datastore", timeoutMs: 120_000);

                // 2) scan
                await RunDockerAllowFindingsAsync($"run --rm -v \"{directory}:/scan:ro\" -v \"{datastore}:/datastore\" {DockerImage} scan --datastore /datastore /scan", timeoutMs: 300_000);

                // 3) report json
                var (code, stdout, stderr) = await RunDockerAsync($"run --rm -v \"{datastore}:/datastore\" {DockerImage} report --datastore /datastore --format json", timeoutMs: 60_000);
                if (code != 0)
                    throw new InvalidOperationException($"Report failed: {stderr}");

                var findings = ParseFindings(stdout, directory);
                return new ScanResult { Findings = findings };
            }
            finally
            {
                try { Directory.Delete(datastore, true); } catch { }
            }
        }

        private static List<Finding> ParseFindings(string json, string baseDir)
        {
            var list = new List<Finding>();
            if (string.IsNullOrWhiteSpace(json)) return list;

            JArray arr;
            try { arr = JArray.Parse(json); }
            catch { return list; }

            foreach (var item in arr)
            {
                var ruleName = item.Value<string>("rule_name") ?? item.Value<string>("rule") ?? "";
                var matches = item["matches"] as JArray;
                if (matches == null) continue;

                foreach (var match in matches)
                {
                    var provenance = match["provenance"]?.FirstOrDefault();
                    var path = provenance? .Value<string>("path") ?? "";

                    var start = match["location"]?["source_span"]?["start"];
                    var line = start?.Value<int?>("line") ?? 0;

                    var preview = match["snippet"]?.Value<string>("matching") ?? "";

                    // Normalize path to host path
                    var abs = CombineSafe(baseDir, path);

                    list.Add(new Finding
                    {
                        RuleName = ruleName,
                        FilePath = abs,
                        Line = line,
                        Preview = Truncate(preview, 120)
                    });
                }
            }

            return list;
        }

        private static string Truncate(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        private static string CombineSafe(string baseDir, string relative)
        {
            try
            {
                if (Path.IsPathRooted(relative)) return relative;
                var combined = Path.GetFullPath(Path.Combine(baseDir, relative));
                return combined;
            }
            catch { return Path.Combine(baseDir, relative ?? string.Empty); }
        }

        private static async Task EnsureDockerAsync()
        {
            var (code, _, _) = await ProcessRunner.RunAsync("docker", "--version", timeoutMs: 10_000);
            if (code != 0) throw new InvalidOperationException("Docker is not available. Please install and start Docker Desktop.");
        }

        private static async Task EnsureJavaAsync()
        {
            var (code, _, _) = await ProcessRunner.RunAsync("java", "-version", timeoutMs: 10_000);
            if (code != 0) throw new InvalidOperationException("Java is not available. Please install a JRE for BFG.");
        }

        private static async Task PullImageAsync()
        {
            // Pull; let caching make it quick if already present
            await ProcessRunner.RunAsync("docker", $"pull {DockerImage}", timeoutMs: 300_000);
        }

        private static async Task<(int, string, string)> RunDockerAsync(string args, int timeoutMs)
        {
            return await ProcessRunner.RunAsync("docker", args, timeoutMs: timeoutMs);
        }

        private static async Task RunDockerAllowFindingsAsync(string args, int timeoutMs)
        {
            var (code, stdout, stderr) = await RunDockerAsync(args, timeoutMs);
            // Nosey Parker may return non-zero when matches are found in some contexts; tolerate common codes
            if (code != 0 && code != 2)
            {
                throw new InvalidOperationException($"Scan failed (exit {code}): {stderr}\n{stdout}");
            }
        }
    }
}

