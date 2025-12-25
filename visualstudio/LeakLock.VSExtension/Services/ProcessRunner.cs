using System;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LeakLock.VSExtension.Services
{
    internal static class ProcessRunner
    {
        public static async Task<(int ExitCode, string StdOut, string StdErr)> RunAsync(
            string fileName,
            string arguments,
            string workingDirectory = null,
            int timeoutMs = 0,
            CancellationToken cancellationToken = default)
        {
            var tcs = new TaskCompletionSource<(int, string, string)>(TaskCreationOptions.RunContinuationsAsynchronously);

            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = string.IsNullOrEmpty(workingDirectory) ? null : workingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            var stdout = new StringBuilder();
            var stderr = new StringBuilder();

            using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            if (timeoutMs > 0)
                cts.CancelAfter(timeoutMs);

            proc.Exited += (_, __) =>
            {
                tcs.TrySetResult((proc.ExitCode, stdout.ToString(), stderr.ToString()));
            };

            try
            {
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }

            using (cts.Token.Register(() =>
            {
                try { if (!proc.HasExited) proc.Kill(true); } catch { }
                tcs.TrySetCanceled();
            }))
            {
                return await tcs.Task.ConfigureAwait(false);
            }
        }
    }
}

