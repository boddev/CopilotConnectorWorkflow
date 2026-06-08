using Xunit;

namespace Ccw.Core.Tests;

/// <summary>
/// Phase 0 scaffold smoke test - proves the test runner is wired up.
/// Real Phase 1 tests land per-slice with parity fixtures (Opus B2/B3/B4).
/// </summary>
public class ScaffoldSmokeTests
{
    [Fact]
    public void SchemaVersion_IsNotEmpty()
    {
        Assert.False(string.IsNullOrEmpty(Ccw.Core.CoreInfo.SchemaVersion));
    }
}
