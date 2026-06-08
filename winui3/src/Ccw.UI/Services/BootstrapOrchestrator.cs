using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Ccw.Bootstrap;

namespace Ccw.UI.Services;

/// <summary>Phase 6 first-run wizard service. Wraps DiagnosticsService +
/// WinGetDriver + SiblingRepoHelper so the wizard ViewModel doesn't need
/// to know about Ccw.Bootstrap directly. Returns plain results — all
/// progress reporting flows through IProgress&lt;string&gt;.</summary>
public sealed class BootstrapOrchestrator
{
    private readonly DiagnosticsService _diag;

    public BootstrapOrchestrator(DiagnosticsService diag)
    {
        _diag = diag;
    }

    public Task<IReadOnlyList<DependencyProbeResult>> ProbeAllAsync(CancellationToken ct = default)
        => _diag.ProbeAllAsync(ct);

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
