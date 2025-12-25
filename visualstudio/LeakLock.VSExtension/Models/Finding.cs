namespace LeakLock.VSExtension.Models
{
    public class Finding
    {
        public string RuleName { get; set; }
        public string FilePath { get; set; }
        public int Line { get; set; }
        public string Preview { get; set; }
    }
}

