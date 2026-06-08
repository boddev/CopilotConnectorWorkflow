// Hand-rolled argv parser ported from src/cli.ts parseArgs.
//
// PARITY DISCIPLINE (plan §4 Phase 4 — Opus I7):
//   * Step log stream parity is the contract; --help / usage / error TEXT
//     is intentionally divergent (the Node parser is intentionally lax).
//     But ARGV SEMANTICS we keep faithful so existing CI scripts work
//     unchanged.
//   * Lax semantics matched from Node:
//       - First non-flag arg is `cmd`. argv after it is scanned.
//       - `--flag` followed by a non-`--`-prefixed token consumes that
//         token as the flag's value.
//       - `--flag` followed by another `--` flag (or EOF) is treated as
//         a boolean true.
//       - Repeated `--flag value` overwrites (last-wins). The Node code
//         in `compare` has a SECOND PASS that collects `--job` twice
//         from raw argv — handled separately in CompareCommand.
//       - Unknown flags are accepted (no error).
//   * The parser is forward-only single pass; no validation; no typing.
//     Commands do their own validation (matching Node's `required` helper).

namespace Ccw.Cli;

internal sealed class ParsedArgs
{
    public required string Cmd { get; init; }
    public required IReadOnlyDictionary<string, string> Flags { get; init; }
    public required IReadOnlyDictionary<string, bool> Booleans { get; init; }

    /// <summary>Original argv tail (everything after cmd). Used by compare
    /// to collect repeated --job flags without normalizing them through
    /// the dictionary.</summary>
    public required IReadOnlyList<string> Tail { get; init; }

    public string? Flag(string name) => Flags.TryGetValue(name, out var v) ? v : null;
    public bool Bool(string name) => Booleans.TryGetValue(name, out var v) && v;
}

internal static class ArgvParser
{
    public static ParsedArgs Parse(string[] argv)
    {
        ArgumentNullException.ThrowIfNull(argv);
        if (argv.Length == 0)
        {
            return new ParsedArgs
            {
                Cmd = "help",
                Flags = new Dictionary<string, string>(StringComparer.Ordinal),
                Booleans = new Dictionary<string, bool>(StringComparer.Ordinal),
                Tail = [],
            };
        }
        var cmd = argv[0];
        var flags = new Dictionary<string, string>(StringComparer.Ordinal);
        var booleans = new Dictionary<string, bool>(StringComparer.Ordinal);
        var tail = new List<string>(argv.Length - 1);
        for (var i = 1; i < argv.Length; i++) tail.Add(argv[i]);

        for (var i = 0; i < tail.Count; i++)
        {
            var a = tail[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = a[2..];
            var hasNext = i + 1 < tail.Count;
            var next = hasNext ? tail[i + 1] : null;
            if (next is not null && !next.StartsWith("--", StringComparison.Ordinal))
            {
                flags[key] = next;
                i++;
            }
            else
            {
                booleans[key] = true;
            }
        }

        return new ParsedArgs
        {
            Cmd = cmd,
            Flags = flags,
            Booleans = booleans,
            Tail = tail,
        };
    }

    /// <summary>Mirror of Node compare's second pass: collect every
    /// <c>--job &lt;id&gt;</c> from a raw tail in order, returning the
    /// ids verbatim.</summary>
    public static IReadOnlyList<string> CollectRepeatedJobIds(IReadOnlyList<string> tail)
    {
        ArgumentNullException.ThrowIfNull(tail);
        var ids = new List<string>(2);
        for (var i = 0; i < tail.Count; i++)
        {
            if (tail[i] == "--job" && i + 1 < tail.Count)
            {
                ids.Add(tail[i + 1]);
                i++;
            }
        }
        return ids;
    }
}
