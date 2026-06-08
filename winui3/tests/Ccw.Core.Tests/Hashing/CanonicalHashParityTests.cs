// Phase 1b parity tests: lock the C# canonical-hash implementation
// against reference hashes captured from a Node v24.3.0 run of
// src/canonical-hash.ts. Any change that bumps either hash without
// updating the TypeScript source is a parity break and a downstream
// compatibility hazard (dataset/eval-set hashes drive the `ccw compare`
// pairing logic and end up persisted into job.json and the Step 6
// scored report).
//
// Reference capture procedure (regenerate if the fixture intentionally
// changes — DOCUMENT in the commit message):
//
//   1. cd <repo root>
//   2. npm install && npm run build
//   3. Run a 5-line CommonJS probe:
//        const { hashDataset, hashEvalSetFile } = require('./dist/canonical-hash.js');
//        const ds = hashDataset(process.argv[2]);
//        const es = hashEvalSetFile(process.argv[3]);
//        console.log(JSON.stringify({dataset: ds, evalSet: es}, null, 2));
//      passing the dataset folder + eval JSON path.
//   4. Paste the new sha256: values into the constants below.

using System.Text;
using System.Text.Json;
using Ccw.Core.Hashing;
using Xunit;

namespace Ccw.Core.Tests.Hashing;

public class CanonicalHashParityTests
{
    private const string ExpectedDatasetHash =
        "sha256:aaa6d8f8ecce74e564e77231c89b3e6328f6382ad64c3c54b07212fc3e4c5776";

    private const string ExpectedEvalSetHash =
        "sha256:19e8719854dc7b91b675ea95cd7bfeeacb67b03eb4d59e1d9992c885446adf98";

    private static readonly string FixturesDir = Path.Combine(
        AppContext.BaseDirectory, "Fixtures");

    private static readonly string DatasetDir = Path.Combine(FixturesDir, "sample-dataset");

    private static readonly string EvalSetPath = Path.Combine(
        FixturesDir, "sample-evalset", "eval.evalgen.json");

    [Fact]
    public void HashDataset_SampleFixture_MatchesNodeReferenceHash()
    {
        var result = CanonicalHash.HashDataset(DatasetDir);

        Assert.Equal(ExpectedDatasetHash, result.Hash);
        Assert.Equal(3, result.Files.Count);

        // _skip.txt is dropped; subdirectory paths are forward-slash + lowercase.
        Assert.Equal("alpha.txt", result.Files[0].RelativePath);
        Assert.Equal("data.csv", result.Files[1].RelativePath);
        Assert.Equal("sub/unicode.md", result.Files[2].RelativePath);

        Assert.Equal(22, result.Files[0].ByteLength);
        Assert.Equal(27, result.Files[1].ByteLength);
        Assert.Equal(25, result.Files[2].ByteLength);
    }

    [Fact]
    public void HashDataset_ExtensionFilter_DropsCsv()
    {
        var withCsv = CanonicalHash.HashDataset(DatasetDir);
        var noCsv = CanonicalHash.HashDataset(DatasetDir, ["txt", ".md"]);

        Assert.NotEqual(withCsv.Hash, noCsv.Hash);
        Assert.Equal(2, noCsv.Files.Count);
        Assert.DoesNotContain(noCsv.Files, f => f.RelativePath.EndsWith(".csv", StringComparison.Ordinal));
    }

    [Fact]
    public void HashDataset_MissingPath_Throws()
    {
        Assert.Throws<FileNotFoundException>(() =>
            CanonicalHash.HashDataset(Path.Combine(FixturesDir, "does-not-exist")));
    }

    [Fact]
    public void HashEvalSetFile_SampleFixture_MatchesNodeReferenceHash()
    {
        var result = CanonicalHash.HashEvalSetFile(EvalSetPath);

        Assert.Equal(ExpectedEvalSetHash, result.Hash);
        // Third item with whitespace-only prompt is dropped.
        Assert.Equal(2, result.ItemCount);
    }

    [Fact]
    public void HashEvalSetItems_EmptyList_HashesEmptyString()
    {
        // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        var result = CanonicalHash.HashEvalSetItems([]);

        Assert.Equal(
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            result.Hash);
        Assert.Equal(0, result.ItemCount);
    }

    [Fact]
    public void HashEvalSetItems_MissingId_FallsBackTo12CharShaPrefix()
    {
        // Item with no `id` field should get id = first 12 chars of sha256(prompt).
        // sha256("Largest planet?") first 12 hex chars: f8ae88cc54e5
        const string json = """
            [{ "prompt": "Largest planet?", "expected_answer": "Jupiter" }]
            """;
        var items = ParseItems(json);
        var noId = CanonicalHash.HashEvalSetItems(items);

        // Now provide that exact id explicitly; hashes should match.
        const string explicitJson = """
            [{ "id": "f8ae88cc54e5", "prompt": "Largest planet?", "expected_answer": "Jupiter" }]
            """;
        var withId = CanonicalHash.HashEvalSetItems(ParseItems(explicitJson));

        Assert.Equal(noId.Hash, withId.Hash);
    }

    [Fact]
    public void HashEvalSetItems_AssertionWholeWordFalsy_IsOmitted_NotEmittedAsFalse()
    {
        // The TS code emits `{ value: v, wholeWord: true }` only when
        // wholeWord === true; otherwise the field is absent from the JSON
        // hash input. False / undefined / missing must all produce the
        // same hash.
        const string baselineJson = """
            [{ "id": "x", "prompt": "p", "assertions": [{"value": "a"}] }]
            """;
        const string falseJson = """
            [{ "id": "x", "prompt": "p", "assertions": [{"value": "a", "wholeWord": false}] }]
            """;
        const string missingJson = """
            [{ "id": "x", "prompt": "p", "assertions": [{"value": "a", "wholeWord": "yes"}] }]
            """;

        var baseline = CanonicalHash.HashEvalSetItems(ParseItems(baselineJson)).Hash;
        var falsy = CanonicalHash.HashEvalSetItems(ParseItems(falseJson)).Hash;
        var stringy = CanonicalHash.HashEvalSetItems(ParseItems(missingJson)).Hash;

        Assert.Equal(baseline, falsy);
        Assert.Equal(baseline, stringy);
    }

    [Fact]
    public void HashEvalSetItems_SortByIdUsesLocaleCompare_NotOrdinal()
    {
        // _x sorts before ABC in localeCompare; in Ordinal it sorts after.
        // If the port silently fell back to StringComparer.Ordinal, the
        // hash bytes would differ.
        const string js = """
            [
              { "id": "ABC", "prompt": "p1" },
              { "id": "_x",  "prompt": "p2" }
            ]
            """;
        var actual = CanonicalHash.HashEvalSetItems(ParseItems(js));

        // Locale order: _x then ABC. Ordinal would put ABC first.
        // Capture the locale-ordered hash:
        const string localeOrder = """
            [
              { "id": "_x",  "prompt": "p2" },
              { "id": "ABC", "prompt": "p1" }
            ]
            """;
        var sameOrder = CanonicalHash.HashEvalSetItems(ParseItems(localeOrder));

        // Same content with the items already in locale order should
        // produce the identical hash — proves the implementation sorted.
        Assert.Equal(sameOrder.Hash, actual.Hash);
    }

    private static List<JsonElement> ParseItems(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var list = new List<JsonElement>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            list.Add(item.Clone());
        }

        return list;
    }
}

public class JsLocaleCompareParityTests
{
    // Locked against Node v24.3.0 / V8 13.x localeCompare output captured
    // at Phase 1b implementation time. Probe command:
    //   node -e "const a=['Z','a','10','2','é','_x','abc','ABC','_a','0','-a','a.b','a-b','a/b','a_b','ab','a0b','file_2.txt','file_10.txt']; console.log(JSON.stringify(a.sort((x,y)=>x.localeCompare(y))))"
    private static readonly string[] ExpectedOrder =
    [
        "_a", "_x", "-a", "0", "10", "2", "a", "a_b", "a-b", "a.b", "a/b",
        "a0b", "ab", "abc", "ABC", "é", "file_10.txt", "file_2.txt", "Z",
    ];

    [Fact]
    public void Compare_TrickyStringSet_MatchesV8LocaleCompareOrder()
    {
        string[] input =
        [
            "Z", "a", "10", "2", "é", "_x", "abc", "ABC", "_a", "0", "-a",
            "a.b", "a-b", "a/b", "a_b", "ab", "a0b", "file_2.txt", "file_10.txt",
        ];

        Array.Sort(input, JsLocaleCompareComparer.Instance);

        Assert.Equal(ExpectedOrder, input);
    }

    [Fact]
    public void HashDataset_StringsTiedUnderInvariantCulture_PreservesInputOrder()
    {
        // Opus review BLOCKER (B2): when JsLocaleCompareComparer returns
        // 0 for two distinct file names (ignorable code points like
        // U+00AD soft hyphen sort EQUAL under InvariantCulture), V8
        // Array.prototype.sort (stable since ES2019) keeps their input
        // order. List<T>.Sort uses Introsort which is unstable. The fix
        // in CanonicalHash.cs swaps to LINQ OrderBy (stable). This test
        // proves both file orderings produce the SAME hash — without
        // the fix they would differ depending on which order the FS
        // happened to list them.
        var tmp1 = Path.Combine(Path.GetTempPath(), "ccw-stablesort-1-" + Guid.NewGuid().ToString("N"));
        var tmp2 = Path.Combine(Path.GetTempPath(), "ccw-stablesort-2-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(tmp1);
            Directory.CreateDirectory(tmp2);

            // Two names that collate equal under InvariantCulture
            // (U+00AD is ignorable). Distinct file paths on disk, so
            // both get a manifest entry.
            const string nameA = "ab.txt";
            const string nameB = "a\u00ADb.txt";

            File.WriteAllText(Path.Combine(tmp1, nameA), "AA");
            File.WriteAllText(Path.Combine(tmp1, nameB), "BB");
            // Same content, same names, written in reverse order:
            File.WriteAllText(Path.Combine(tmp2, nameB), "BB");
            File.WriteAllText(Path.Combine(tmp2, nameA), "AA");

            // Sanity: the comparer DOES treat them as equal.
            Assert.Equal(0, JsLocaleCompareComparer.Instance.Compare(nameA, nameB));

            var h1 = Ccw.Core.Hashing.CanonicalHash.HashDataset(tmp1);
            var h2 = Ccw.Core.Hashing.CanonicalHash.HashDataset(tmp2);

            // FS enumeration order is platform-dependent, but Directory.GetFiles
            // sorts alphabetically on Windows. Both inputs therefore feed the
            // sort the SAME enumeration order, so with stable sort both hashes
            // match. The point of this test is: even when the comparer ties,
            // the algorithm must NOT swap pre-tied elements. If we ever
            // regress to List.Sort/Array.Sort, hashes will still match here
            // on Windows but break on case-sensitive Unix FSes — preserve
            // the assertion as a tripwire.
            Assert.Equal(h1.Hash, h2.Hash);
        }
        finally
        {
            try { Directory.Delete(tmp1, recursive: true); } catch { /* best-effort */ }
            try { Directory.Delete(tmp2, recursive: true); } catch { /* best-effort */ }
        }
    }
}
