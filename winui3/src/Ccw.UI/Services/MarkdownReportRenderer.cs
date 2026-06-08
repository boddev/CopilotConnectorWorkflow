using System;
using System.Collections.Generic;
using System.IO;
using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;

namespace Ccw.UI.Services;

/// <summary>Render a Markdown file (a step report or compare report) into
/// XAML inline blocks. NOT WebView2 — plan §5d Opus I4: keep WebView2
/// off the dependency list entirely.
///
/// Phase 5 reviewer fold-in (Opus B1 + GPT B2): the per-question and
/// summary tables in agent-response-scores.md / comparison-report.md are
/// the entire payload — Markdig parses them as Table blocks which the
/// original switch silently dropped. We now render Table blocks as a
/// fixed-width monospaced pipe layout inside a RichTextBlock Paragraph
/// (cheap, no Grid/RowDef gymnastics) and add an explicit `default:` arm
/// that emits a debug Run so future unhandled block types don't silently
/// disappear.</summary>
public sealed class MarkdownReportRenderer
{
    private readonly MarkdownPipeline _pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .Build();

    public IList<Microsoft.UI.Xaml.Documents.Block> Render(string markdownText)
    {
        var doc = Markdown.Parse(markdownText ?? string.Empty, _pipeline);
        var blocks = new List<Microsoft.UI.Xaml.Documents.Block>();
        foreach (var node in doc)
        {
            switch (node)
            {
                case HeadingBlock h:
                    blocks.Add(RenderHeading(h));
                    break;
                case ParagraphBlock p:
                    blocks.Add(RenderParagraph(p));
                    break;
                case Markdig.Syntax.ListBlock list:
                    foreach (var item in list)
                    {
                        if (item is ListItemBlock li)
                        {
                            foreach (var inner in li)
                            {
                                if (inner is ParagraphBlock pp)
                                    blocks.Add(RenderBullet(pp));
                            }
                        }
                    }
                    break;
                case FencedCodeBlock code:
                    blocks.Add(RenderCode(code));
                    break;
                case ThematicBreakBlock:
                    blocks.Add(new Paragraph { Inlines = { new Run { Text = "\u2500\u2500\u2500\u2500\u2500" } } });
                    break;
                case Table tbl:
                    blocks.Add(RenderTable(tbl));
                    break;
                case QuoteBlock q:
                    foreach (var sub in q)
                    {
                        if (sub is ParagraphBlock qp)
                            blocks.Add(RenderQuote(qp));
                    }
                    break;
                default:
                    blocks.Add(new Paragraph
                    {
                        Inlines = { new Run { Text = $"[unrendered {node.GetType().Name}]", FontStyle = Windows.UI.Text.FontStyle.Italic } }
                    });
                    break;
            }
        }
        return blocks;
    }

    public string LoadFile(string path)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return string.Empty;
        return File.ReadAllText(path);
    }

    private static Paragraph RenderHeading(HeadingBlock h)
    {
        var p = new Paragraph { Margin = new Thickness(0, h.Level == 1 ? 16 : 12, 0, 4) };
        var size = h.Level switch { 1 => 22.0, 2 => 18.0, 3 => 16.0, _ => 14.0 };
        var run = new Run { Text = InlineText(h.Inline), FontWeight = FontWeights.SemiBold, FontSize = size };
        p.Inlines.Add(run);
        return p;
    }

    private static Paragraph RenderParagraph(ParagraphBlock p)
    {
        var para = new Paragraph();
        AppendInlines(para.Inlines, p.Inline);
        return para;
    }

    private static Paragraph RenderBullet(ParagraphBlock p)
    {
        var para = new Paragraph { Margin = new Thickness(16, 0, 0, 0) };
        para.Inlines.Add(new Run { Text = "\u2022  " });
        AppendInlines(para.Inlines, p.Inline);
        return para;
    }

    private static Paragraph RenderQuote(ParagraphBlock p)
    {
        var para = new Paragraph { Margin = new Thickness(16, 4, 0, 4) };
        para.Inlines.Add(new Run { Text = "\u2503  ", FontWeight = FontWeights.SemiBold });
        AppendInlines(para.Inlines, p.Inline);
        return para;
    }

    private static Paragraph RenderCode(FencedCodeBlock code)
    {
        var para = new Paragraph
        {
            Margin = new Thickness(0, 4, 0, 4),
        };
        var run = new Run
        {
            Text = code.Lines.ToString(),
            FontFamily = new FontFamily("Consolas, Cascadia Code, Courier New"),
        };
        para.Inlines.Add(run);
        return para;
    }

    private static Paragraph RenderTable(Table tbl)
    {
        // Collect rows of cell text first to compute column widths.
        var rows = new List<List<string>>();
        var headerIdx = -1;
        foreach (var row in tbl)
        {
            if (row is not TableRow tr) continue;
            var cells = new List<string>();
            foreach (var cell in tr)
            {
                if (cell is not TableCell tc) continue;
                var sb = new System.Text.StringBuilder();
                foreach (var inner in tc)
                {
                    if (inner is ParagraphBlock pp) sb.Append(InlineText(pp.Inline));
                    else sb.Append(inner.ToString());
                }
                cells.Add(sb.ToString().Replace("\n", " ").Replace("\r", " "));
            }
            if (tr.IsHeader) headerIdx = rows.Count;
            rows.Add(cells);
        }
        if (rows.Count == 0)
            return new Paragraph();

        var colCount = 0;
        foreach (var r in rows) if (r.Count > colCount) colCount = r.Count;
        var widths = new int[colCount];
        foreach (var r in rows)
            for (var i = 0; i < r.Count; i++)
                if (r[i].Length > widths[i]) widths[i] = r[i].Length;

        var para = new Paragraph { Margin = new Thickness(0, 4, 0, 8) };
        var font = new FontFamily("Consolas, Cascadia Code, Courier New");
        for (var r = 0; r < rows.Count; r++)
        {
            var line = new System.Text.StringBuilder();
            line.Append("| ");
            for (var c = 0; c < colCount; c++)
            {
                var cell = c < rows[r].Count ? rows[r][c] : string.Empty;
                line.Append(cell.PadRight(widths[c]));
                line.Append(" | ");
            }
            para.Inlines.Add(new Run
            {
                Text = line.ToString(),
                FontFamily = font,
                FontWeight = r == headerIdx ? FontWeights.SemiBold : FontWeights.Normal,
            });
            para.Inlines.Add(new LineBreak());
            if (r == headerIdx)
            {
                var sep = new System.Text.StringBuilder();
                sep.Append('|');
                for (var c = 0; c < colCount; c++)
                {
                    sep.Append('-', widths[c] + 2);
                    sep.Append('|');
                }
                para.Inlines.Add(new Run { Text = sep.ToString(), FontFamily = font });
                para.Inlines.Add(new LineBreak());
            }
        }
        return para;
    }

    private static void AppendInlines(InlineCollection target, ContainerInline? inline)
    {
        if (inline is null) return;
        foreach (var node in inline)
        {
            switch (node)
            {
                case LiteralInline lit:
                    target.Add(new Run { Text = lit.Content.ToString() });
                    break;
                case CodeInline ci:
                    target.Add(new Run
                    {
                        Text = ci.Content,
                        FontFamily = new FontFamily("Consolas, Cascadia Code, Courier New"),
                    });
                    break;
                case LineBreakInline:
                    target.Add(new LineBreak());
                    break;
                case EmphasisInline em when em.DelimiterCount >= 2:
                    var bold = new Bold();
                    AppendInlines(bold.Inlines, em);
                    target.Add(bold);
                    break;
                case EmphasisInline em:
                    var italic = new Italic();
                    AppendInlines(italic.Inlines, em);
                    target.Add(italic);
                    break;
                case LinkInline link:
                    if (Uri.TryCreate(link.Url, UriKind.Absolute, out var href))
                    {
                        var hl = new Hyperlink { NavigateUri = href };
                        AppendInlines(hl.Inlines, link);
                        target.Add(hl);
                    }
                    else
                    {
                        var span = new Span();
                        AppendInlines(span.Inlines, link);
                        target.Add(span);
                    }
                    break;
                case ContainerInline ci2:
                    AppendInlines(target, ci2);
                    break;
            }
        }
    }

    private static string InlineText(ContainerInline? inline)
    {
        if (inline is null) return string.Empty;
        var sb = new System.Text.StringBuilder();
        foreach (var node in inline)
        {
            if (node is LiteralInline lit) sb.Append(lit.Content.ToString());
            else if (node is CodeInline ci) sb.Append(ci.Content);
            else if (node is LineBreakInline) sb.Append('\n');
            else if (node is ContainerInline ci2) sb.Append(InlineText(ci2));
        }
        return sb.ToString();
    }
}
