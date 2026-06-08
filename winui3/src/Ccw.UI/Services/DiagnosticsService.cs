using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Ccw.Bootstrap;

namespace Ccw.UI.Services;

/// <summary>Wraps <see cref="DependencyProbes"/> for the Diagnostics page.
/// Single source of truth shared with the future first-run wizard
/// (Phase 6).</summary>
public sealed class DiagnosticsService
{
    public Task<IReadOnlyList<DependencyProbeResult>> ProbeAllAsync(CancellationToken ct = default)
        => Task.Run(() => DependencyProbes.ProbeAll(), ct);
}
