using Ccw.Core.Scoring;
using Xunit;

namespace Ccw.Core.Tests.Scoring;

// Opus Q1 — NFKD trap. FoldText must handle:
//   - precomposed vs combining é (both → "e")
//   - ligatures (ﬁ → "fi")
//   - full-width digits/letters
//   - case folding via InvariantCulture
public sealed class ScoringTests
{
    [Theory]
    [InlineData("café", "cafe")]                  // precomposed é (U+00E9)
    [InlineData("cafe\u0301", "cafe")]            // combining acute on 'e'
    [InlineData("ﬁle", "file")]                   // ligature fi (U+FB01) -> NFKD splits
    [InlineData("ＡＢＣ", "abc")]                 // full-width letters
    [InlineData("１２３", "123")]                 // full-width digits
    [InlineData("Hello, World!", "hello, world!")]  // FoldText preserves punctuation
    [InlineData("MiXeD", "mixed")]
    [InlineData("", "")]
    public void FoldText_NormalizesUnicode(string input, string expected)
    {
        var folded = ResponseScorer.FoldText(input);
        Assert.Equal(expected, folded);
    }

    [Fact]
    public void ContainsValue_IsCaseInsensitive()
    {
        // FoldText always lowercases via InvariantCulture, so case never matters.
        Assert.True(ResponseScorer.ContainsValue("Hello World", "world", wholeWord: false));
        Assert.True(ResponseScorer.ContainsValue("Hello World", "WORLD", wholeWord: false));
        Assert.True(ResponseScorer.ContainsValue("Hello World", "World", wholeWord: true));
    }

    [Fact]
    public void ContainsValue_FoldsLigaturesAndDiacritics()
    {
        Assert.True(ResponseScorer.ContainsValue("café au lait", "cafe", wholeWord: false));
        Assert.True(ResponseScorer.ContainsValue("ﬁle handle", "file", wholeWord: false));
    }

    [Fact]
    public void HasCitation_DetectsCitationMarkers()
    {
        Assert.True(ResponseScorer.HasCitation("Per the docs [^1^] this works"));
        Assert.True(ResponseScorer.HasCitation("As I cite earlier..."));
        Assert.False(ResponseScorer.HasCitation("No citation here."));
    }
}
