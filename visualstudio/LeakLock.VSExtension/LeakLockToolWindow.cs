using Microsoft.VisualStudio.Shell;
using System;
using System.Runtime.InteropServices;

namespace LeakLock.VSExtension
{
    [Guid("7E4ADE0C-9F2F-4B16-8C10-E1F4A2F2B9E0")]
    public class LeakLockToolWindow : ToolWindowPane
    {
        public LeakLockToolWindow() : base(null)
        {
            Caption = "Leak Lock Scanner";
            Content = new LeakLockToolWindowControl();
        }
    }
}

