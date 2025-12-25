using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace LeakLock.VSExtension
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration("Leak Lock", "Secret scanning and cleanup", "0.1.0")] // VS displays this in the Help/About
    [ProvideToolWindow(typeof(LeakLockToolWindow))]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [Guid(PackageGuidString)]
    public sealed class VSPackage : AsyncPackage
    {
        public const string PackageGuidString = "40BFF617-8E4E-4CDB-9BD7-8EEAC71C6027";

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await this.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            await Commands.OpenLeakLockCommand.InitializeAsync(this);
        }
    }
}

