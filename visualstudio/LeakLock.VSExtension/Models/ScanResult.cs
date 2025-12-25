using System.Collections.Generic;

namespace LeakLock.VSExtension.Models
{
    public class ScanResult
    {
        public List<Finding> Findings { get; set; } = new();
        public int Count => Findings?.Count ?? 0;
    }
}

