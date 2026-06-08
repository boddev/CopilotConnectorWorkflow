using System;
using System.Globalization;
using System.IO;
using Ccw.Core.Models;
using Ccw.UI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class ComparePage : Page
{
    private readonly JobService _jobs;
    private readonly MarkdownReportRenderer _md;

    public ComparePage()
    {
        InitializeComponent();
        _jobs = App.GetService<JobService>();
        _md = App.GetService<MarkdownReportRenderer>();
        Loaded += (_, __) => PopulatePickers();
    }

    private void PopulatePickers()
    {
        var jobs = _jobs.ListJobs();
        JobABox.ItemsSource = jobs;
        JobBBox.ItemsSource = jobs;
    }

    private void Refresh_Click(object sender, RoutedEventArgs e) => PopulatePickers();

    private void RunCompare_Click(object sender, RoutedEventArgs e)
    {
        if (JobABox.SelectedItem is not JobRecord a || JobBBox.SelectedItem is not JobRecord b)
        {
            ReportBlock.Blocks.Clear();
            ReportBlock.Blocks.Add(new Microsoft.UI.Xaml.Documents.Paragraph
            {
                Inlines = { new Microsoft.UI.Xaml.Documents.Run { Text = "Pick Job A and Job B." } }
            });
            return;
        }
        try
        {
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            var workspaceParent = Path.GetDirectoryName(_jobs.WorkspaceRoot()) ?? Directory.GetCurrentDirectory();
            var outDir = Path.Combine(workspaceParent, "compare-reports", $"{stamp}-{a.Id}-vs-{b.Id}");
            var result = _jobs.Compare(a.Id, b.Id, outDir);
            var markdown = File.Exists(result.ReportMdPath) ? File.ReadAllText(result.ReportMdPath) : "(no report)";
            ReportBlock.Blocks.Clear();
            foreach (var block in _md.Render(markdown)) ReportBlock.Blocks.Add(block);
        }
        catch (Exception ex)
        {
            ReportBlock.Blocks.Clear();
            ReportBlock.Blocks.Add(new Microsoft.UI.Xaml.Documents.Paragraph
            {
                Inlines = { new Microsoft.UI.Xaml.Documents.Run { Text = $"Failed: {ex.Message}" } }
            });
        }
    }
}
