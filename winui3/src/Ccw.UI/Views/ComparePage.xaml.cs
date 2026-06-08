using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Ccw.Core.Models;
using Ccw.UI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class ComparePage : Page
{
    private readonly JobService _jobs;
    private readonly MarkdownReportRenderer _md;
    private IReadOnlyList<JobRecord> _allJobs = Array.Empty<JobRecord>();

    public ComparePage()
    {
        InitializeComponent();
        _jobs = App.GetService<JobService>();
        _md = App.GetService<MarkdownReportRenderer>();
        Loaded += async (_, __) => await PopulatePickersAsync();
    }

    private async System.Threading.Tasks.Task PopulatePickersAsync()
    {
        _allJobs = await _jobs.ListJobsAsync();
        JobABox.ItemsSource = _allJobs;
        ApplyJobBFilter(JobABox.SelectedItem as JobRecord);
    }

    private void ApplyJobBFilter(JobRecord? selectedA)
    {
        if (selectedA is null)
        {
            // Phase 5 reviewer fold-in (Opus N5 + GPT IMPORTANT #4): empty Job B
            // until the user picks Job A — eliminates the "same job twice" case.
            JobBBox.ItemsSource = Array.Empty<JobRecord>();
            return;
        }
        var compatible = _allJobs.Where(b => JobService.ArePairEligible(selectedA, b)).ToList();
        JobBBox.ItemsSource = compatible;
    }

    private void JobABox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        JobBBox.SelectedItem = null;
        ApplyJobBFilter(JobABox.SelectedItem as JobRecord);
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await PopulatePickersAsync();

    private async void RunCompare_Click(object sender, RoutedEventArgs e)
    {
        if (JobABox.SelectedItem is not JobRecord a || JobBBox.SelectedItem is not JobRecord b)
        {
            ShowMessage("Pick Job A and Job B.");
            return;
        }
        if (!JobService.ArePairEligible(a, b))
        {
            ShowMessage("Selected pair is not comparable (need matching dataset + evalSetHash with opposite NoEnhance).");
            return;
        }
        try
        {
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            var workspaceParent = Path.GetDirectoryName(_jobs.WorkspaceRoot()) ?? Directory.GetCurrentDirectory();
            var outDir = Path.Combine(workspaceParent, "compare-reports", $"{stamp}-{a.Id}-vs-{b.Id}");
            ShowMessage("Comparing\u2026");
            var result = await _jobs.CompareAsync(a.Id, b.Id, outDir);
            var markdown = File.Exists(result.ReportMdPath) ? File.ReadAllText(result.ReportMdPath) : "(no report)";
            ReportBlock.Blocks.Clear();
            foreach (var block in _md.Render(markdown)) ReportBlock.Blocks.Add(block);
        }
        catch (Exception ex)
        {
            ShowMessage($"Failed: {ex.Message}");
        }
    }

    private void ShowMessage(string text)
    {
        ReportBlock.Blocks.Clear();
        ReportBlock.Blocks.Add(new Microsoft.UI.Xaml.Documents.Paragraph
        {
            Inlines = { new Microsoft.UI.Xaml.Documents.Run { Text = text } }
        });
    }
}
