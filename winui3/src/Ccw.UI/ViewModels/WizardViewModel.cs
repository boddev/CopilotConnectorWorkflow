using System;
using System.Collections.Generic;
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
/// to see the rows flip green.
///
/// Phase 6 reviewer fold-ins (Opus + GPT, convergent):
///   - SrcRoot is threaded into the probe pass as a BootstrapOptions so
///     a user-overridden src directory is honored at probe time, not
///     just at clone time (GPT I1).
///   - After winget install we refresh the in-process PATH from the
///     registry before re-probing — installers update the user/machine
///     PATH outside this process, and without the refresh the row stays
///     red even after a successful install (Opus I1, GPT I2).
///   - Install/Clone take a cancellation token tied to a VM-owned
///     CTS. The page wires a Cancel button (Opus I2, GPT I5).
///   - RefreshAsync is wrapped in try/catch so probe exceptions
///     surface as a ProgressText diagnostic rather than escape through
///     `async void OnNavigatedTo` (GPT I4).
///   - Install error message includes a bounded tail of both stdout
///     and stderr — winget routinely writes the actual failure reason
///     to stdout (Opus N5, GPT I6).
///   - HasProbed gates Install and Clone so the user can't invoke a
///     no-op against an empty Rows collection (GPT N1, I7).
/// </summary>
public partial class WizardViewModel : ObservableObject, IDisposable
{
    private readonly BootstrapOrchestrator _bootstrap;
    private CancellationTokenSource? _cts;
    private bool _disposed;

    public WizardViewModel(BootstrapOrchestrator bootstrap)
    {
        _bootstrap = bootstrap;
    }

    /// <summary>Probe rows. Wraps DependencyProbeResult with per-row
    /// busy/error state for the UI.</summary>
    public ObservableCollection<WizardProbeRow> Rows { get; } = new();

    [ObservableProperty] public partial bool IsBusy { get; set; }
    [ObservableProperty] public partial bool HasProbed { get; set; }
    [ObservableProperty] public partial bool CloneSiblings { get; set; } = true;
    [ObservableProperty] public partial string SrcRoot { get; set; } =
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "src");
    [ObservableProperty] public partial string ProgressText { get; set; } = "";
    [ObservableProperty] public partial bool AllSatisfied { get; set; }

    public bool CanInstall => HasProbed && !IsBusy &&
        Rows.Any(r => !r.Probe.Present || !r.Probe.MeetsMinimumVersion);

    public bool CanClone => HasProbed && !IsBusy && CloneSiblings &&
        // Need Git + Node before clone/build can succeed (GPT I7).
        Rows.Any(r => r.Probe.Name == "git" && r.Probe.Present) &&
        Rows.Any(r => r.Probe.Name == "node" && r.Probe.Present && r.Probe.MeetsMinimumVersion);

    public bool CanCancel => IsBusy;

    partial void OnIsBusyChanged(bool value)
    {
        OnPropertyChanged(nameof(CanInstall));
        OnPropertyChanged(nameof(CanClone));
        OnPropertyChanged(nameof(CanCancel));
    }
    partial void OnHasProbedChanged(bool value)
    {
        OnPropertyChanged(nameof(CanInstall));
        OnPropertyChanged(nameof(CanClone));
    }
    partial void OnCloneSiblingsChanged(bool value) => OnPropertyChanged(nameof(CanClone));

    private CancellationToken ResetCancellation()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = new CancellationTokenSource();
        return _cts.Token;
    }

    [RelayCommand]
    public void Cancel()
    {
        try { _cts?.Cancel(); }
        catch { /* best-effort */ }
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsBusy = true;
        var ct = ResetCancellation();
        try
        {
            ProgressText = "Probing...";
            Rows.Clear();
            var options = new BootstrapOptions { SrcRoot = SrcRoot };
            var results = await _bootstrap.ProbeAllAsync(options, ct).ConfigureAwait(true);
            foreach (var r in results) Rows.Add(new WizardProbeRow(r));
            AllSatisfied = BootstrapOrchestrator.AllSatisfied(results);
            HasProbed = true;
            ProgressText = AllSatisfied
                ? "All dependencies satisfied."
                : $"Missing or below-minimum: {Rows.Count(r => !r.Probe.Present || !r.Probe.MeetsMinimumVersion)}.";
        }
        catch (OperationCanceledException)
        {
            ProgressText = "Probe canceled.";
        }
        catch (Exception ex)
        {
            ProgressText = $"Probe failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
            OnPropertyChanged(nameof(CanInstall));
            OnPropertyChanged(nameof(CanClone));
        }
    }

    [RelayCommand]
    public async Task InstallMissingAsync()
    {
        if (!HasProbed)
        {
            await RefreshAsync().ConfigureAwait(true);
            if (!HasProbed) return;
        }
        IsBusy = true;
        var ct = ResetCancellation();
        var anyInstalled = false;
        try
        {
            foreach (var row in Rows.Where(r => !r.Probe.Present || !r.Probe.MeetsMinimumVersion).ToList())
            {
                ct.ThrowIfCancellationRequested();
                if (row.WinGetId is null)
                {
                    row.Status = "Manual install required: " + (row.ManualCommand ?? row.ManualLink ?? "see docs");
                    continue;
                }
                row.Busy = true;
                row.Status = "Installing via winget...";
                ProgressText = $"winget install --id {row.WinGetId}";
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
                        anyInstalled = true;
                    }
                    else if (result.Success)
                    {
                        row.Status = $"Installed (exit {result.ExitCode}).";
                        anyInstalled = true;
                    }
                    else
                    {
                        row.Status = $"WinGet failed (exit 0x{result.ExitCode:X8}). {Bounded(result.Error)} {Bounded(result.Output)}".TrimEnd();
                    }
                }
                catch (OperationCanceledException)
                {
                    row.Status = "Install canceled.";
                    throw;
                }
                catch (Exception ex)
                {
                    row.Status = $"Install threw: {ex.Message}";
                }
                finally { row.Busy = false; }
            }
            if (anyInstalled)
            {
                // Phase 6 fold-in (Opus I1, GPT I2): pull the freshly
                // updated PATH from the registry into this process so
                // the re-probe sees the new binaries.
                BootstrapOrchestrator.RefreshProcessPathFromRegistry();
            }
            await RefreshAsync().ConfigureAwait(true);
        }
        catch (OperationCanceledException)
        {
            ProgressText = "Install canceled.";
        }
        finally
        {
            IsBusy = false;
            OnPropertyChanged(nameof(CanInstall));
            OnPropertyChanged(nameof(CanClone));
        }
    }

    [RelayCommand]
    public async Task CloneSiblingsAsync()
    {
        if (!CloneSiblings) return;
        IsBusy = true;
        var ct = ResetCancellation();
        var reporter = new System.Progress<string>(line =>
        {
            ProgressText = line.Length > 200 ? string.Concat(line.AsSpan(0, 200), "...") : line;
        });
        try
        {
            var options = new BootstrapOptions { SrcRoot = SrcRoot };
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
        catch (OperationCanceledException)
        {
            ProgressText = "Clone canceled.";
        }
        catch (Exception ex)
        {
            ProgressText = $"Clone failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
            OnPropertyChanged(nameof(CanInstall));
            OnPropertyChanged(nameof(CanClone));
        }
    }

    private static string Bounded(string? text)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;
        const int max = 240;
        text = text.Replace("\r\n", " ").Replace("\n", " ").Trim();
        return text.Length <= max ? text : "..." + text[(text.Length - max)..];
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _cts?.Cancel(); } catch { }
        _cts?.Dispose();
        _cts = null;
        GC.SuppressFinalize(this);
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
    public bool HasManualLink => !string.IsNullOrEmpty(ManualLink);

    [ObservableProperty] public partial string Status { get; set; }
    [ObservableProperty] public partial bool Busy { get; set; }
}
