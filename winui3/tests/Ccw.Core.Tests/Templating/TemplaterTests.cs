// Phase 1g parity tests: lock the tiny {{key}} templater against the
// src/templating.ts contract, with explicit coverage of the Agents
// Toolkit ${{ENV_VAR}} preservation guarantee (plan §1g, Opus N4).

using Ccw.Core.Templating;
using Xunit;

namespace Ccw.Core.Tests.Templating;

public class TemplaterTests
{
    private static readonly IReadOnlyDictionary<string, string?> NgoValues =
        new Dictionary<string, string?>
        {
            ["connectorId"] = "ngo-env",
            ["connectorName"] = "NGO Environment",
            ["TEAMS_APP_ID"] = "teams-app-collides-with-at-env-var",
            ["empty"] = "",
            ["nullish"] = null,
        };

    [Fact]
    public void RenderString_KnownKey_Substituted()
    {
        Assert.Equal("hello NGO Environment!",
            Templater.RenderString("hello {{connectorName}}!", NgoValues));
    }

    [Fact]
    public void RenderString_UnknownKey_LeftAsIs()
    {
        Assert.Equal("hello {{unknownThing}}!",
            Templater.RenderString("hello {{unknownThing}}!", NgoValues));
    }

    [Fact]
    public void RenderString_NullValue_BecomesEmptyString()
    {
        Assert.Equal("hello !",
            Templater.RenderString("hello {{nullish}}!", NgoValues));
    }

    [Fact]
    public void RenderString_EmptyValue_RendersEmpty()
    {
        Assert.Equal("hello !",
            Templater.RenderString("hello {{empty}}!", NgoValues));
    }

    [Fact]
    public void RenderString_WhitespaceInsideBraces_Tolerated()
    {
        // Matches TS regex \s* on each side of the key.
        Assert.Equal("hello NGO Environment!",
            Templater.RenderString("hello {{   connectorName   }}!", NgoValues));
    }

    [Fact]
    public void RenderString_AgentsToolkitDollarBraceBrace_LeftLiteral_EvenOnKeyCollision()
    {
        // ${{TEAMS_APP_ID}} must survive verbatim. Values contains
        // TEAMS_APP_ID; without the guard, the result would be
        // "$teams-app-collides-with-at-env-var" which would silently
        // break teamsapp.yml.
        const string input = "appId: ${{TEAMS_APP_ID}}";
        Assert.Equal(input, Templater.RenderString(input, NgoValues));
    }

    [Fact]
    public void RenderString_AgentsToolkitDollarBraceBrace_LeftLiteral_NoCollision()
    {
        // Standard case: env-var name doesn't collide with any values key.
        const string input = "appId: ${{ NEW_ENV_VAR }}";
        Assert.Equal(input, Templater.RenderString(input, NgoValues));
    }

    [Fact]
    public void RenderString_DotAndHyphenKeys_AreMatched()
    {
        // TS regex character class is [\w.-]+ — dots and hyphens allowed.
        var values = new Dictionary<string, string?>
        {
            ["a.b.c"] = "DOTTED",
            ["x-y"] = "DASHED",
        };

        Assert.Equal("DOTTED DASHED",
            Templater.RenderString("{{a.b.c}} {{x-y}}", values));
    }

    [Fact]
    public void RenderString_NonAsciiKey_LeftLiteral()
    {
        // TS \w in JS is ASCII-only. .NET default Unicode would otherwise
        // match `é` as a word char and substitute. Explicit ASCII class
        // means the unicode key is treated as literal.
        var values = new Dictionary<string, string?>
        {
            ["café"] = "should-not-substitute",
        };

        Assert.Equal("{{café}}",
            Templater.RenderString("{{café}}", values));
    }

    [Fact]
    public void RenderString_MultipleSubstitutions_AllReplaced()
    {
        var values = new Dictionary<string, string?>
        {
            ["a"] = "1",
            ["b"] = "2",
        };

        Assert.Equal("1 and 2 and 1 again",
            Templater.RenderString("{{a}} and {{b}} and {{a}} again", values));
    }

    [Fact]
    public void RenderFileToDir_HbsFile_StripsSuffixAndRenders()
    {
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "in.txt.hbs");
        File.WriteAllText(srcPath, "hi {{connectorName}}");

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "deep/in.txt.hbs", NgoValues);

        Assert.True(File.Exists(dest));
        // .hbs stripped from the destination path.
        Assert.EndsWith("deep" + Path.DirectorySeparatorChar + "in.txt", dest, StringComparison.Ordinal);
        Assert.Equal("hi NGO Environment", File.ReadAllText(dest));
    }

    [Fact]
    public void RenderFileToDir_PngFile_CopiedBytesVerbatim()
    {
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "logo.png");
        byte[] payload = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3];
        File.WriteAllBytes(srcPath, payload);

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "logo.png", NgoValues);

        Assert.Equal(payload, File.ReadAllBytes(dest));
    }

    [Fact]
    public void RenderFileToDir_PlainTextFile_CopiedVerbatim_NotRendered()
    {
        // Non-.hbs text files are copied verbatim — no substitution.
        // This matches the TS `else { copyFileSync }` branch.
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "raw.txt");
        File.WriteAllText(srcPath, "literal {{connectorName}} stays put");

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "raw.txt", NgoValues);

        Assert.Equal("literal {{connectorName}} stays put", File.ReadAllText(dest));
    }

    [Fact]
    public void RenderTree_WalksRecursively_AppliesFilter()
    {
        using var tmp = new TempDir();
        var src = Path.Combine(tmp.Path, "src");
        Directory.CreateDirectory(Path.Combine(src, "sub"));
        File.WriteAllText(Path.Combine(src, "keep.txt.hbs"), "{{connectorName}}");
        File.WriteAllText(Path.Combine(src, "skip.md.hbs"), "{{connectorName}}");
        File.WriteAllText(Path.Combine(src, "sub", "deep.txt.hbs"), "{{connectorName}}");

        var dest = Path.Combine(tmp.Path, "dest");
        var rendered = Templater.RenderTree(src, dest, NgoValues, rel => !rel.EndsWith(".md.hbs", StringComparison.Ordinal));

        Assert.Equal(2, rendered.Count);
        Assert.True(File.Exists(Path.Combine(dest, "keep.txt")));
        Assert.True(File.Exists(Path.Combine(dest, "sub", "deep.txt")));
        Assert.False(File.Exists(Path.Combine(dest, "skip.md")));
        Assert.Equal("NGO Environment", File.ReadAllText(Path.Combine(dest, "keep.txt")));
    }

    [Fact]
    public void RenderFileToDir_HbsExtensionCaseSensitive_HBSTreatedAsVerbatim()
    {
        // GPT review IMPORTANT: TS `endsWith('.hbs')` is case-sensitive.
        // A `.HBS` file must NOT be rendered or have its suffix
        // stripped — it copies verbatim like any other text file.
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "raw.HBS");
        File.WriteAllText(srcPath, "literal {{connectorName}} stays put");

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "raw.HBS", NgoValues);

        Assert.EndsWith("raw.HBS", dest, StringComparison.Ordinal);
        Assert.Equal("literal {{connectorName}} stays put", File.ReadAllText(dest));
    }

    [Fact]
    public void RenderFileToDir_HbsExtensionLowercase_StripsAndRenders()
    {
        // Sibling assertion — lowercase .hbs IS rendered.
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "in.txt.hbs");
        File.WriteAllText(srcPath, "{{connectorName}}");

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "in.txt.hbs", NgoValues);

        Assert.EndsWith("in.txt", dest, StringComparison.Ordinal);
        Assert.Equal("NGO Environment", File.ReadAllText(dest));
    }

    [Fact]
    public void RenderFileToDir_HbsWithUtf8Bom_PreservesBomInOutput()
    {
        // Opus review I3: File.ReadAllText auto-strips the UTF-8 BOM
        // (U+FEFF). Node `fs.readFileSync(p,'utf-8')` PRESERVES it. The
        // Templater port reads raw bytes and decodes via UTF8Encoding(false)
        // to keep the BOM in the rendered output — otherwise a BOM'd
        // template (e.g. PowerShell scripts saved by older tooling)
        // would produce a 3-byte parity drift versus the Node renderer.
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "with-bom.txt.hbs");
        // Write source with explicit UTF-8 BOM + body that uses a key.
        var bom = new byte[] { 0xEF, 0xBB, 0xBF };
        var body = System.Text.Encoding.UTF8.GetBytes("Hello {{connectorName}}!");
        File.WriteAllBytes(srcPath, bom.Concat(body).ToArray());

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "with-bom.txt.hbs", NgoValues);

        var outBytes = File.ReadAllBytes(dest);
        // First three bytes must be the BOM.
        Assert.Equal(0xEF, outBytes[0]);
        Assert.Equal(0xBB, outBytes[1]);
        Assert.Equal(0xBF, outBytes[2]);
        // And the substitution still happened.
        var bodyText = System.Text.Encoding.UTF8.GetString(outBytes, 3, outBytes.Length - 3);
        Assert.Equal("Hello NGO Environment!", bodyText);
    }

    [Fact]
    public void RenderFileToDir_VerbatimWithUtf8Bom_PreservesBomInOutput()
    {
        // Non-.hbs files are copied byte-for-byte by File.Copy, which
        // naturally preserves any BOM. Lock that behavior with a test
        // so a future refactor to "read text then write text" can't
        // regress us silently.
        using var tmp = new TempDir();
        var srcPath = Path.Combine(tmp.Path, "verbatim.bin");
        var bom = new byte[] { 0xEF, 0xBB, 0xBF };
        var body = System.Text.Encoding.UTF8.GetBytes("no substitution here");
        File.WriteAllBytes(srcPath, bom.Concat(body).ToArray());

        var destDir = Path.Combine(tmp.Path, "out");
        var dest = Templater.RenderFileToDir(srcPath, destDir, "verbatim.bin", NgoValues);

        Assert.Equal(File.ReadAllBytes(srcPath), File.ReadAllBytes(dest));
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; }

        public TempDir()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "ccw-templater-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch { /* best-effort cleanup */ }
        }
    }
}
