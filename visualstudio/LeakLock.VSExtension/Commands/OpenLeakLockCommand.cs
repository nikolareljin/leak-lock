using System;
using System.ComponentModel.Design;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace LeakLock.VSExtension.Commands
{
    internal sealed class OpenLeakLockCommand
    {
        public const int CommandId = 0x0100;
        public static readonly Guid CommandSet = new Guid("80EE2C2F-5FE4-43B9-8C77-7FBBBF95D6F4");
        private readonly AsyncPackage _package;

        private OpenLeakLockCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package ?? throw new ArgumentNullException(nameof(package));
            var menuCommandID = new CommandID(CommandSet, CommandId);
            var menuItem = new MenuCommand(Execute, menuCommandID);
            commandService.AddCommand(menuItem);
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var commandService = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
            _ = new OpenLeakLockCommand(package, commandService);
        }

        private void Execute(object sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _package.JoinableTaskFactory.RunAsync(async delegate
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var window = await _package.ShowToolWindowAsync(typeof(LeakLockToolWindow), 0, true, _package.DisposalToken);
            });
        }
    }
}

