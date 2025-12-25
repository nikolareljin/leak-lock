using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using Microsoft.Win32;
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using LeakLock.VSExtension.Models;
using LeakLock.VSExtension.Services;

namespace LeakLock.VSExtension
{
    public partial class LeakLockToolWindowControl : UserControl
    {
        private readonly ScannerService _scanner;
        private readonly BfgService _bfg;
        private readonly ObservableCollection<Finding> _findings = new();

        public LeakLockToolWindowControl()
        {
            InitializeComponent();
            ResultsGrid.ItemsSource = _findings;
            _scanner = new ScannerService();
            _bfg = new BfgService();
            DirectoryText.Text = TryGetSolutionDirectory() ?? string.Empty;
        }

        private static string TryGetSolutionDirectory()
        {
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var dte = Package.GetGlobalService(typeof(DTE)) as DTE2;
                if (dte != null && !string.IsNullOrEmpty(dte.Solution?.FullName))
                {
                    return Path.GetDirectoryName(dte.Solution.FullName);
                }
            }
            catch { /* ignore */ }
            return null;
        }

        private async void InstallDeps_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                await _scanner.InstallDependenciesAsync();
                MessageBox.Show("Dependencies verified/installed.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Failed to install dependencies: {ex.Message}", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void SelectDir_Click(object sender, RoutedEventArgs e)
        {
            var dlg = new System.Windows.Forms.FolderBrowserDialog();
            var res = dlg.ShowDialog();
            if (res == System.Windows.Forms.DialogResult.OK)
            {
                DirectoryText.Text = dlg.SelectedPath;
            }
        }

        private async void Scan_Click(object sender, RoutedEventArgs e)
        {
            var dir = DirectoryText.Text?.Trim();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                MessageBox.Show("Please select a valid directory.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            try
            {
                _findings.Clear();
                var results = await _scanner.ScanAsync(dir);
                foreach (var f in results.Findings)
                    _findings.Add(f);

                if (!_findings.Any())
                {
                    MessageBox.Show("No secrets found.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Scan failed: {ex.Message}", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void ResultsGrid_MouseDoubleClick(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            OpenSelectedFile();
        }

        private void OpenFile_Click(object sender, RoutedEventArgs e)
        {
            OpenSelectedFile();
        }

        private void OpenSelectedFile()
        {
            if (ResultsGrid.SelectedItem is not Finding f || string.IsNullOrWhiteSpace(f.FilePath))
                return;

            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var dte = Package.GetGlobalService(typeof(DTE)) as DTE2;
                dte?.ItemOperations.OpenFile(f.FilePath);
                if (f.Line > 0)
                {
                    var doc = dte?.ActiveDocument;
                    var sel = doc?.Selection as TextSelection;
                    sel?.GotoLine(f.Line, true);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Failed to open file: {ex.Message}", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private async void RunBfg_Click(object sender, RoutedEventArgs e)
        {
            var dir = DirectoryText.Text?.Trim();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                MessageBox.Show("Please select a valid directory.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            if (!_findings.Any())
            {
                MessageBox.Show("No findings to remove. Run a scan first.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            var confirm = MessageBox.Show(
                $"This will rewrite git history for '{dir}'. Ensure you have a backup. Continue?",
                "Leak Lock",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.Yes)
                return;

            try
            {
                await _bfg.RunCleanupAsync(dir, _findings.ToList());
                MessageBox.Show("BFG cleanup completed. Consider reviewing changes and force-pushing if required.", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"BFG cleanup failed: {ex.Message}", "Leak Lock", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }
}

