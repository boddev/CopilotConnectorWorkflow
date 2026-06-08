// Port of src/templating.ts.
//
// Tiny mustache-like substitution {{key}} -> values[key]. UNKNOWN keys
// are left literal so Microsoft 365 Agents Toolkit's ${{ENV_VAR}}
// syntax survives the render unchanged (the Toolkit consumes ${{...}}
// downstream during teamsapp.yml processing). The C# port adds an
// EXPLICIT guard for collision case where ${{KEY}} would otherwise
// match {{KEY}} with a populated value — TS today happens to never hit
// this because the values dict it gets is hand-picked to exclude Agents
// Toolkit env-var names, but the guard makes the contract explicit
// rather than incidental (plan §1g, Opus N4).
//
// PARITY DISCIPLINE:
//   * Regex character class is `[A-Za-z0-9_.-]+` (ASCII), matching JS
//     `\w.-`. .NET regex defaults to Unicode `\w`, which would change
//     behavior for non-ASCII keys — even though we expect ASCII-only
//     keys, the explicit class is the safe choice.
//   * Binary file allowlist matches the TS source exactly:
//     .png .jpg .jpeg .gif .ico .zip. These are copied verbatim.
//   * `.hbs` suffix is stripped from the destination filename.
//     Non-.hbs text files are also copied verbatim (no rendering).
//   * `renderFileToDir` returns the absolute destination path.

using System.Text;
using System.Text.RegularExpressions;

namespace Ccw.Core.Templating;

/// <summary>Tiny {{key}} template renderer. Matches src/templating.ts.</summary>
public static class Templater
{
    private static readonly HashSet<string> BinaryExtensions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip",
        };

    // ASCII `\w.-` matches JS `\w.-`. .NET regex defaults to Unicode `\w`
    // which would also match e.g. é — undesirable here. The explicit
    // character class is the safe choice.
    private static readonly Regex Pattern = new(
        @"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}",
        RegexOptions.Compiled);

    /// <summary>Substitute <c>{{key}}</c> tokens. Unknown keys are left as-is.
    /// Keys preceded by <c>$</c> (i.e. inside an Agents Toolkit <c>${{...}}</c>
    /// span) are NEVER substituted even if a matching value exists.</summary>
    public static string RenderString(string template, IReadOnlyDictionary<string, string?> values)
    {
        ArgumentNullException.ThrowIfNull(template);
        ArgumentNullException.ThrowIfNull(values);

        return Pattern.Replace(template, match =>
        {
            // Agents Toolkit preservation guard: ${{ANY}} is left literal
            // even if a values entry collides. The TS source happens to
            // never hit this because callers don't populate AT env-var
            // names, but we make the contract explicit here.
            var start = match.Index;
            if (start > 0 && template[start - 1] == '$')
            {
                return match.Value;
            }

            var key = match.Groups[1].Value;
            if (!values.TryGetValue(key, out var v))
            {
                return match.Value;
            }

            return v ?? string.Empty;
        });
    }

    /// <summary>Render a single file. Strips <c>.hbs</c> suffix.
    /// Binary-allowlisted extensions copy verbatim; .hbs files render;
    /// every other file copies verbatim.</summary>
    /// <returns>Absolute destination path.</returns>
    public static string RenderFileToDir(
        string sourceFile,
        string destinationDir,
        string destinationRelativePath,
        IReadOnlyDictionary<string, string?> values)
    {
        ArgumentException.ThrowIfNullOrEmpty(sourceFile);
        ArgumentException.ThrowIfNullOrEmpty(destinationDir);
        ArgumentException.ThrowIfNullOrEmpty(destinationRelativePath);
        ArgumentNullException.ThrowIfNull(values);

        // GPT review IMPORTANT: TS `endsWith('.hbs')` is case-sensitive.
        // Use Ordinal (not OrdinalIgnoreCase) so a file named `foo.HBS`
        // is treated as a verbatim copy, not a template — matches Node.
        var targetRel = destinationRelativePath.EndsWith(".hbs", StringComparison.Ordinal)
            ? destinationRelativePath[..^4]
            : destinationRelativePath;

        var dest = Path.Combine(destinationDir, targetRel.Replace('/', Path.DirectorySeparatorChar));
        var destDirAbs = Path.GetDirectoryName(dest);
        if (!string.IsNullOrEmpty(destDirAbs))
        {
            Directory.CreateDirectory(destDirAbs);
        }

        var ext = Path.GetExtension(sourceFile);
        var isBinary = BinaryExtensions.Contains(ext);

        if (isBinary)
        {
            File.Copy(sourceFile, dest, overwrite: true);
        }
        else if (sourceFile.EndsWith(".hbs", StringComparison.Ordinal))
        {
            // Opus review I3: File.ReadAllText auto-strips a UTF-8 BOM
            // (U+FEFF). Node's fs.readFileSync(p,'utf-8') PRESERVES it.
            // For a BOM'd template, that's a 3-byte parity drift. Read
            // raw bytes and decode without BOM stripping to match Node.
            var raw = File.ReadAllBytes(sourceFile);
            var text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: false)
                .GetString(raw);
            var rendered = RenderString(text, values);

            // Write back bytes; if the source had a BOM the rendered
            // string still begins with U+FEFF (substitution never
            // touches the BOM since {{key}} can't start with FEFF).
            // We use NEW UTF8Encoding(false) -> no BOM written by us.
            File.WriteAllBytes(dest, new UTF8Encoding(false).GetBytes(rendered));
        }
        else
        {
            File.Copy(sourceFile, dest, overwrite: true);
        }

        return dest;
    }

    /// <summary>Walk a source tree and render every file (with optional filter).
    /// Returns the absolute destination paths in traversal order.</summary>
    public static IReadOnlyList<string> RenderTree(
        string sourceDir,
        string destinationDir,
        IReadOnlyDictionary<string, string?> values,
        Func<string, bool>? filter = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(sourceDir);
        ArgumentException.ThrowIfNullOrEmpty(destinationDir);
        ArgumentNullException.ThrowIfNull(values);

        var output = new List<string>();
        Walk(sourceDir, string.Empty, destinationDir, values, filter, output);
        return output;
    }

    private static void Walk(
        string current,
        string rel,
        string destinationDir,
        IReadOnlyDictionary<string, string?> values,
        Func<string, bool>? filter,
        List<string> output)
    {
        // Matches TS Node `fs.readdirSync(cur)` (no explicit sort).
        // Node returns directory entries in filesystem order, which on
        // NTFS is typically alphabetical. .NET's
        // Directory.GetFileSystemEntries does NOT guarantee any order;
        // we sort ordinally to make tree renders deterministic across
        // hosts. This affects ONLY the `out[]` traversal order returned
        // to callers; the rendered file BYTES are identical regardless.
        var entries = Directory.GetFileSystemEntries(current)
            .OrderBy(p => Path.GetFileName(p), StringComparer.Ordinal)
            .ToArray();

        foreach (var p in entries)
        {
            var name = Path.GetFileName(p);
            var r = string.IsNullOrEmpty(rel) ? name : $"{rel}/{name}";

            if (Directory.Exists(p))
            {
                Walk(p, r, destinationDir, values, filter, output);
            }
            else
            {
                if (filter is not null && !filter(r))
                {
                    continue;
                }

                output.Add(RenderFileToDir(p, destinationDir, r, values));
            }
        }
    }
}
