using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Ccw.Bootstrap;
using Ccw.UI.Services;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Ccw.UI.ViewModels;

/// <summary>Phase 6 first-run wizard ViewModel. Three logical stages:
///   1. Probe — DependencyProbes.ProbeAll() (Diagnostics).
///   2. Install — WinGetDriver.InstallAsync per missing dep with manual
///      fallbacks.
///   3. Clone — SiblingRepoHelper.* for EvaluationCLI + CopilotConnectorSkill.
/// Each stage is reactive; the user can rerun probes after each install
/// to see the rows flip green.</summary>
public partial class WizardViewModel : ObservableObject
{
    private readonly BootstrapOrchestrator _bootstrap;

    public WizardViewModel(BootstrapOrchestrator bootstrap)
    {
        _bootstrap = bootstrap;
    }

    /// <summary>Probe rows. Wraps DependencyProbeResult with per-row
    /// busy/error state for the UI.</summary>
    public ObservableCollection<WizardProbeRow> Rows { get; } = new();

    [ObservableProperty] public partial bool IsBusy { get; set; }
    [ObservableProperty] public partial bool CloneSiblings { get; set; } = true;
    [ObservableProperty] public partial string SrcRoot { get; set; } =
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "src");
    [ObservableProperty] public partial string ProgressText { get; set; } = "";
    [ObservableProperty] public partial bool AllSatisfied { get; set; }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsBusy = true;
        try
        {
            ProgressText = "Probing...";
            Rows.Clear();
            var results = await _bootstrap.ProbeAllAsync().ConfigureAwait(true);
            foreach (var r in results) Rows.Add(new WizardProbeRow(r));
            AllSatisfied = BootstrapOrchestrator.AllSatisfied(results);
            ProgressText = AllSatisfied
                ? "All dependencies satisfied."
                : $"Missing or below-minimum: {Rows.Count(r => !r.Probe.Present || !r.Probe.MeetsMinimumVersion)}.";
        }
        finally { IsBusy = false; }
    }

    [RelayCommand]
    public async Task InstallMissingAsync()
    {
        IsBusy = true;
        try
        {
            foreach (var row in Rows.Where(r => !r.Probe.Present || !r.Probe.MeetsMinimumVersion).ToList())
            {
                if (row.WinGetId is null)
                {
                    row.Status = "Manual install required: " + (row.ManualCommand ?? row.ManualLink ?? "see docs");
                    continue;
                }
                row.Busy = true;
                row.Status = "Installing via winget...";
                ProgressText = $"winget install --id {row.WinGetId}";
                var ct = CancellationToken.None;
                try
                {
                    var result = await _bootstrap.InstallAsync(row.Probe.Name, ct).ConfigureAwait(true);
                    if (result is null)
                    {
                        row.Status = "No WinGet ID; install manually.";
                    }
                    else if (result.AlreadyInstalled)
                    {
                        row.Status = "Already installed (no action taken).";
                    }
                    else if (result.Success)
                    {
                        row.Status = $"Installed (exit {result.ExitCode}).";
                    }
                    else
                    {
                        row.Status = $"WinGet failed (exit 0x{result.ExitCode:X8}). {result.Error ?? ""}";
                    }
                }
                catch (Exception ex)
                {
                    row.Status = $"Install threw: {ex.Message}";
                }
                finally { row.Busy = false; }
            }
            await RefreshAsync().ConfigureAwait(true);
        }
        finally { IsBusy = false; }
    }

    [RelayCommand]
    public async Task CloneSiblingsAsync()
    {
        if (!CloneSiblings) return;
        IsBusy = true;
        var log = new StringBuilder();
        var reporter = new System.Progress<string>(line =>
        {
            log.AppendLine(line);
            ProgressText = line.Length > 200 ? string.Concat(line.AsSpan(0, 200), "...") : line;
        });
        try
        {
            var options = new BootstrapOptions { SrcRoot = SrcRoot };
            var ct = CancellationToken.None;
            var eval = await _bootstrap.EnsureEvaluationCliAsync(options, reporter, ct).ConfigureAwait(true);
            if (!eval.Success)
            {
                ProgressText = $"EvaluationCLI: {eval.Error}";
                return;
            }
            var skill = await _bootstrap.EnsureCopilotConnectorSkillAsync(options, reporter, ct).ConfigureAwait(true);
            if (!skill.Success)
            {
                ProgressText = $"CopilotConnectorSkill: {skill.Error}";
                return;
            }
            ProgressText = "Sibling repos ready.";
            await RefreshAsync().ConfigureAwait(true);
        }
        finally { IsBusy = false; }
    }
}

/// <summary>UI wrapper around a probe result so per-row status/busy flags
/// don't pollute the immutable record.</summary>
public partial class WizardProbeRow : ObservableObject
{
    public WizardProbeRow(DependencyProbeResult probe)
    {
        Probe = probe;
        WinGetId = WinGetDriver.GetWinGetIdFor(probe.Name);
        ManualLink = WinGetDriver.ManualInstallLinks.TryGetValue(probe.Name, out var link) ? link : null;
        ManualCommand = WinGetDriver.ManualInstallCommands.TryGetValue(probe.Name, out var cmd) ? cmd : null;
        Status = probe.Present
            ? probe.MeetsMinimumVersion
                ? "OK (" + (probe.Version ?? "") + ")"
                : "Below minimum: " + (probe.Version ?? "")
            : "Missing.";
    }

    public DependencyProbeResult Probe { get; }
    public string? WinGetId { get; }
    public string? ManualLink { get; }
    public string? ManualCommand { get; }

    [ObservableProperty] public partial string Status { get; set; }
    [ObservableProperty] public partial bool Busy { get; set; }
}
