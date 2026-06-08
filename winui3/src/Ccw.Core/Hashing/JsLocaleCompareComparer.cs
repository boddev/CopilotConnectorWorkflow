// JS-localeCompare-equivalent string comparer.
//
// Why a dedicated type instead of inline `StringComparer.InvariantCulture`:
//   * Self-documents intent at every call site that uses it.
//   * Provides a single chokepoint to swap the implementation if a future
//     ICU / V8 update drifts (the parity fixture in
//     tests/Ccw.Core.Tests/Hashing/JsLocaleCompareParityTests.cs locks the
//     contract).
//   * Removes any ambiguity that a future contributor might "fix" by
//     swapping to StringComparer.Ordinal — which silently corrupts every
//     canonical hash downstream.
//
// EMPIRICAL FINDING (probed against Node v24.3.0 / V8 13.x):
// .NET's StringComparer.InvariantCulture produces an identical sort order
// to JS `String.prototype.localeCompare()` (with no args) across the
// tricky-string fixture. .NET ICU's invariant collation and V8's default
// root-locale collation agree on ASCII letters, digits, '_', '-', '.',
// '/', and a sampling of non-ASCII (é). If they ever diverge, swap the
// underlying field to a hand-rolled comparer.

using System.Globalization;

namespace Ccw.Core.Hashing;

/// <summary>
/// String comparer whose ordering matches JavaScript
/// <c>String.prototype.localeCompare()</c> (called with no arguments,
/// i.e. root-locale default sensitivity). This is what
/// <c>src/canonical-hash.ts</c> uses to sort dataset relative paths and
/// canonical eval-item IDs, and the contract Phase 1b is built on.
/// </summary>
public sealed class JsLocaleCompareComparer : IComparer<string>
{
    /// <summary>Singleton instance.</summary>
    public static JsLocaleCompareComparer Instance { get; } = new();

    private static readonly StringComparer Inner = StringComparer.InvariantCulture;

    private JsLocaleCompareComparer()
    {
    }

    public int Compare(string? x, string? y) => Inner.Compare(x, y);
}
