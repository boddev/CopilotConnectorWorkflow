// JS-compatible math helpers. Critical for parity with V8 numeric semantics —
// .NET defaults to MidpointRounding.ToEven (banker's rounding), but JS Math.round
// is floor(x + 0.5). See Opus-4.8 review B1 (Phase 1 remaining).

namespace Ccw.Core.Util;

public static class JsMath
{
    /// <summary>JS Math.round: floor(x + 0.5). Differs from System.Math.Round which uses banker's rounding by default.</summary>
    public static double Round(double value) => Math.Floor(value + 0.5);

    /// <summary>JS Math.round, integer result.</summary>
    public static long RoundToLong(double value) => (long)Math.Floor(value + 0.5);
}
