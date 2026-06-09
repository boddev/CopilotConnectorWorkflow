using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using Ccw.Core.Util;
using Xunit;

namespace Ccw.Core.Tests.Util;

// Opus B2: DirHash MUST use Ordinal (UTF-16 code-unit) sort, NOT InvariantCulture.
// Opus B3: ObjectHash applies its key whitelist recursively, matching JS
// JSON.stringify(obj, Object.keys(obj).sort()).
public sealed class HashHelpersTests
{
    [Fact]
    public void DirHash_StableAcrossRuns()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ccw-hash-" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "A.txt"), "alpha");
            File.WriteAllText(Path.Combine(dir, "ZZ.txt"), "zulu");
            File.WriteAllText(Path.Combine(dir, "_a.txt"), "underscore");
            File.WriteAllText(Path.Combine(dir, "a.txt"), "lowercase");

            var hash1 = HashHelpers.DirHash(dir);
            var hash2 = HashHelpers.DirHash(dir);
            Assert.Equal(hash1, hash2);
            Assert.Equal(16, hash1.Length);

            // Regression check: adding a new file changes the hash.
            File.WriteAllText(Path.Combine(dir, "extra.txt"), "extra");
            var hash3 = HashHelpers.DirHash(dir);
            Assert.NotEqual(hash1, hash3);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* swallow */ }
        }
    }

    [Fact]
    public void ObjectHash_AppliesWhitelistRecursively_ObjectPathContract()
    {
        // CAVEAT (Opus Phase-2 NB-3): the production ONLY caller is
        // stepInputsHash(parts: unknown[]) which passes an array. For
        // bare-object inputs, this helper's key-order semantics differ
        // from JS replacer-array emit. This test pins the IMPLEMENTED
        // C# behavior (insertion order + recursive whitelist), not
        // cross-runtime byte equality. Don't add a new production caller
        // that hashes a bare object without revisiting HashHelpers.ObjectHash.
        //
        // Mirrors: JSON.stringify(obj, Object.keys(obj).sort())
        // The replacer-array filter applies at EVERY nesting level, not just the top.
        var obj = new JsonObject
        {
            ["a"] = 1,
            ["b"] = new JsonObject
            {
                ["a"] = 2,    // survives (key "a" in whitelist)
                ["c"] = 3,    // dropped (key "c" not in whitelist)
                ["b"] = 4,    // survives
            },
        };
        var hash1 = HashHelpers.ObjectHash(obj);

        // Same object but with "c" replaced by a different value: should hash identically
        // (proves "c" was dropped, not stringified).
        var obj2 = new JsonObject
        {
            ["a"] = 1,
            ["b"] = new JsonObject
            {
                ["a"] = 2,
                ["c"] = "completely different value",
                ["b"] = 4,
            },
        };
        var hash2 = HashHelpers.ObjectHash(obj2);
        Assert.Equal(hash1, hash2);

        // But changing a whitelisted nested value DOES change the hash.
        var obj3 = new JsonObject
        {
            ["a"] = 1,
            ["b"] = new JsonObject
            {
                ["a"] = 999,
                ["c"] = 3,
                ["b"] = 4,
            },
        };
        var hash3 = HashHelpers.ObjectHash(obj3);
        Assert.NotEqual(hash1, hash3);
    }

    [Fact]
    public void FileHash_StableAndShort()
    {
        var path = Path.Combine(Path.GetTempPath(), "ccw-file-" + Path.GetRandomFileName());
        File.WriteAllText(path, "hello world\n");
        try
        {
            var h = HashHelpers.FileHash(path);
            Assert.Equal(16, h.Length);
            Assert.True(h.All(c => "0123456789abcdef".Contains(c)));
        }
        finally
        {
            try { File.Delete(path); } catch { /* swallow */ }
        }
    }
}
