using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Ccw.Bootstrap;
using Microsoft.Win32;

namespace Ccw.UI.Services;

/// <summary>Phase 6 first-run wizard service. Wraps DiagnosticsService +
/// WinGetDriver + SiblingRepoHelper so the wizard ViewModel doesn't need
/// to know about Ccw.Bootstrap directly. Returns plain results — all
/// progress reporting flows through IProgress&lt;string&gt;.</summary>
public sealed class BootstrapOrchestrator
{
    private readonly DiagnosticsService _diag;
    private readonly object _cacheLock = new();
    private IReadOnlyList<DependencyProbeResult>? _cachedProbes;
    private BootstrapOptions? _cachedOptions;

    public BootstrapOrchestrator(DiagnosticsService diag)
    {
        _diag = diag;
    }

    /// <summary>Get the most recently captured probe result. The shell's
    /// non-blocking banner uses this so it doesn't kick off a second
    /// parallel probe when the wizard already has one running
    /// (Phase 6 reviewer Opus I3).</summary>
    public IReadOnlyList<DependencyProbeResult>? CachedProbes
    {
        get { lock (_cacheLock) return _cachedProbes; }
    }

    /// <summary>Get cached probe results if any, otherwise probe.
    /// Used by MainShell so the launch-time banner doesn't fight the
    /// wizard for the same probe slots.</summary>
    public async Task<IReadOnlyList<DependencyProbeResult>> GetOrProbeAsync(
        BootstrapOptions? options = null,
        CancellationToken ct = default)
    {
        lock (_cacheLock)
        {
            if (_cachedProbes is not null) return _cachedProbes;
        }
        return await ProbeAllAsync(options, ct).ConfigureAwait(false);
    }

    /// <summary>Run all probes, optionally with a custom <see cref="BootstrapOptions"/>
    /// (e.g. user-overridden SrcRoot). Caches the result so MainShell can
    /// piggyback off the wizard's snapshot rather than re-running probes
    /// (Phase 6 reviewer Opus I3, GPT I1).</summary>
    public async Task<IReadOnlyList<DependencyProbeResult>> ProbeAllAsync(
        BootstrapOptions? options = null,
        CancellationToken ct = default)
    {
        var probes = options is null
            ? await _diag.ProbeAllAsync(ct).ConfigureAwait(false)
            : await Task.Run(() => DependencyProbes.ProbeAll(options), ct).ConfigureAwait(false);
        lock (_cacheLock)
        {
            _cachedProbes = probes;
            _cachedOptions = options;
        }
        return probes;
    }

    /// <summary>Refresh the in-process PATH from the user + machine
    /// registry hives. Phase 6 reviewer (Opus I1, GPT I2): when winget
    /// installs Node/Git/etc., the new directory is appended to the
    /// user/machine PATH in the registry, but the running process keeps
    /// its launch-time PATH snapshot. Re-probing without refreshing PATH
    /// leaves the row red even though the install succeeded.</summary>
    public static void RefreshProcessPathFromRegistry()
    {
        try
        {
            var machine = string.Empty;
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
            {
                machine = key?.GetValue("Path", string.Empty) as string ?? string.Empty;
            }
            var user = string.Empty;
            using (var key = Registry.CurrentUser.OpenSubKey("Environment"))
            {
                user = key?.GetValue("Path", string.Empty) as string ?? string.Empty;
            }
            // Machine PATH is searched first in cmd.exe semantics; we
            // concatenate machine + user the same way `cmd /c set PATH`
            // would emit after a fresh logon.
            var combined = string.IsNullOrEmpty(user) ? machine : machine + ";" + user;
            if (!string.IsNullOrEmpty(combined))
            {
                System.Environment.SetEnvironmentVariable("PATH", combined, System.EnvironmentVariableTarget.Process);
            }
        }
        catch
        {
            // Best-effort — if the read fails we keep the snapshot PATH.
        }
    }

    /// <summary>Install a single dependency by name. Resolves the WinGet ID
    /// internally; returns null Result if no WinGet mapping exists (caller
    /// should fall back to the manual command from
    /// <see cref="WinGetDriver.ManualInstallCommands"/>).</summary>
    public async Task<WinGetInstallResult?> InstallAsync(string depName, CancellationToken ct = default)
    {
        var id = WinGetDriver.GetWinGetIdFor(depName);
        if (id is null) return null;
        return await WinGetDriver.InstallAsync(id, ct).ConfigureAwait(false);
    }

    public Task<SiblingRepoResult> EnsureEvaluationCliAsync(
        BootstrapOptions options,
        System.IProgress<string>? progress = null,
        CancellationToken ct = default)
        => SiblingRepoHelper.EnsureEvaluationCliAsync(options, progress, ct);

    public Task<SiblingRepoResult> EnsureCopilotConnectorSkillAsync(
        BootstrapOptions options,
        System.IProgress<string>? progress = null,
        CancellationToken ct = default)
        => SiblingRepoHelper.EnsureCopilotConnectorSkillAsync(options, progress, ct);

    /// <summary>True when ALL probes report Present + MeetsMinimumVersion.
    /// The Shell banner uses this to decide whether to nag the user.</summary>
    public static bool AllSatisfied(IReadOnlyList<DependencyProbeResult> probes)
    {
        foreach (var p in probes)
        {
            if (!p.Present || !p.MeetsMinimumVersion) return false;
        }
        return true;
    }
}
