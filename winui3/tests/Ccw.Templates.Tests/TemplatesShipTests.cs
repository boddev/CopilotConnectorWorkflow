// Phase 8 — templates snapshot harness.
//
// Layered diff strategy (plan §8):
//   - byte-exact for templates (no normalization)
//   - canonical JSON only for *semantic* artifacts (job.json, scored
//     reports). The connector-project / deploy templates are
//     byte-verbatim — CRLF/LF or whitespace drift on the build machine
//     would silently change downstream artifacts.
//
// These tests assert that:
//   1. The Content include in Ccw.Templates.csproj actually copies the
//      templates/ tree to <output>/templates/ so TemplatesInfo.TemplatesRoot
//      resolves at runtime (Phase 7 packaging depends on this for MSIX +
//      portable ZIP).
//   2. TemplatesInfo.TemplatesRoot picks up the CCW_TEMPLATES_ROOT
//      environment override.
//   3. Every byte of every file under the source-tree templates/ is
//      preserved byte-for-byte at the runtime location.

using System.IO;
using System.Security.Cryptography;
using Xunit;

namespace Ccw.Templates.Tests;

public class TemplatesShipTests
{
    [Fact]
    public void TemplatesRoot_ExistsNextToTestAssembly()
    {
        // AppContext.BaseDirectory is the test runner's bin/.../net10.0/ —
        // the Content include should have copied the templates tree there.
        Assert.True(
            Directory.Exists(TemplatesInfo.TemplatesRoot),
            $"Expected templates/ next to the test assembly at '{TemplatesInfo.TemplatesRoot}', " +
            "but the directory does not exist. Check Ccw.Templates.csproj's Content include and that " +
            "the consuming test project has a transitive ProjectReference to Ccw.Templates.");
    }

    [Fact]
    public void TemplatesRoot_ContainsConnectorProjectAndDeploy()
    {
        Assert.True(Directory.Exists(TemplatesInfo.ConnectorProjectRoot),
            $"Expected '{TemplatesInfo.ConnectorProjectRoot}' to exist.");
        Assert.True(Directory.Exists(TemplatesInfo.DeployRoot),
            $"Expected '{TemplatesInfo.DeployRoot}' to exist.");
    }

    [Fact]
    public void EnvOverride_TakesPrecedence_WhenSet()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "ccw-templates-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            Environment.SetEnvironmentVariable(TemplatesInfo.EnvOverride, tempDir);
            try
            {
                Assert.Equal(tempDir, TemplatesInfo.TemplatesRoot);
            }
            finally
            {
                Environment.SetEnvironmentVariable(TemplatesInfo.EnvOverride, null);
            }

            // After clearing, must fall back to AppContext.BaseDirectory + "templates".
            var expectedFallback = Path.Combine(AppContext.BaseDirectory, "templates");
            Assert.Equal(expectedFallback, TemplatesInfo.TemplatesRoot);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void EnvOverride_Ignored_WhenDirectoryDoesNotExist()
    {
        var nonExistent = Path.Combine(Path.GetTempPath(), "ccw-no-such-dir-" + Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable(TemplatesInfo.EnvOverride, nonExistent);
        try
        {
            // Should silently fall back to the AppContext.BaseDirectory path
            // rather than returning a stale/invalid override path.
            Assert.NotEqual(nonExistent, TemplatesInfo.TemplatesRoot);
        }
        finally
        {
            Environment.SetEnvironmentVariable(TemplatesInfo.EnvOverride, null);
        }
    }

    /// <summary>Byte-exact verification: every file in the source-tree
    /// templates/ directory matches the runtime-copied one. This is the
    /// load-bearing guarantee that downstream snapshot diffs see identical
    /// bytes regardless of CRLF/LF / encoding drift on the build machine.</summary>
    [Fact]
    public void EveryTemplateFile_MatchesSourceTree_ByteForByte()
    {
        var sourceRoot = LocateSourceTreeTemplates();
        if (sourceRoot is null)
        {
            // Running from an out-of-tree publish (e.g. inside the portable
            // ZIP / inside MSIX) — there is no source tree to compare. The
            // other tests still verify the runtime templates exist; skip
            // this one rather than fail.
            return;
        }

        var runtimeRoot = TemplatesInfo.TemplatesRoot;

        foreach (var sourceFile in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourceRoot, sourceFile)
                .Replace(Path.DirectorySeparatorChar, '/');
            var runtimeFile = Path.Combine(runtimeRoot, rel.Replace('/', Path.DirectorySeparatorChar));

            Assert.True(File.Exists(runtimeFile),
                $"Source template '{rel}' was not copied to runtime location '{runtimeFile}'. " +
                "Check Ccw.Templates.csproj Content include glob.");

            var sourceHash = Sha256(sourceFile);
            var runtimeHash = Sha256(runtimeFile);
            Assert.True(sourceHash == runtimeHash,
                $"Template '{rel}' bytes drifted between source ({sourceHash}) and runtime ({runtimeHash}). " +
                "Most likely cause: CRLF/LF normalization on copy. Check .gitattributes pins under templates/.");
        }
    }

    private static string Sha256(string path)
    {
        using var sha = SHA256.Create();
        using var fs = File.OpenRead(path);
        var bytes = sha.ComputeHash(fs);
        return Convert.ToHexString(bytes);
    }

    /// <summary>Walk up from the test bin/ directory to find the repo root
    /// (heuristic: contains a `templates/` directory and a `.git` directory
    /// or a `winui3/` directory). Returns null if not found (out-of-tree
    /// publish).</summary>
    private static string? LocateSourceTreeTemplates()
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 12 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir, "templates");
            var winui3 = Path.Combine(dir, "winui3");
            var git = Path.Combine(dir, ".git");
            if (Directory.Exists(candidate) && (Directory.Exists(winui3) || Directory.Exists(git)))
            {
                return candidate;
            }
            dir = Path.GetDirectoryName(dir);
        }
        return null;
    }
}
