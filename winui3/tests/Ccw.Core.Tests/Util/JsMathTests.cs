using Ccw.Core.Util;
using Xunit;

namespace Ccw.Core.Tests.Util;

// Opus B1: JS Math.round = floor(x + 0.5). .NET Math.Round defaults to banker's rounding (ToEven).
// These midpoint fixtures lock the V8-compatible behavior into every JsMath.Round consumer
// (Scoring.RoundPct/Average, JobComparer.RoundDelta, identity-transform.round3 when ported).
public sealed class JsMathTests
{
    [Theory]
    [InlineData(0.5, 1.0)]
    [InlineData(1.5, 2.0)]
    [InlineData(2.5, 3.0)]    // V8: 3, .NET ToEven: 2
    [InlineData(3.5, 4.0)]
    [InlineData(4.5, 5.0)]    // V8: 5, .NET ToEven: 4
    [InlineData(-0.5, 0.0)]   // V8 Math.round(-0.5) === 0 (rounds toward +Inf)
    [InlineData(-1.5, -1.0)]  // V8: -1, .NET ToEven: -2
    [InlineData(-2.5, -2.0)]  // V8: -2
    [InlineData(0.0, 0.0)]
    [InlineData(1.0, 1.0)]
    [InlineData(0.4999999, 0.0)]
    [InlineData(0.5000001, 1.0)]
    public void Round_MatchesV8(double input, double expected)
    {
        Assert.Equal(expected, JsMath.Round(input));
    }
}
