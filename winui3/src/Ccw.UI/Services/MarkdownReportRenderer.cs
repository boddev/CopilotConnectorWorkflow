using System;
using System.Collections.Generic;
using System.IO;
using Markdig;
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
/// off the dependency list entirely.</summary>
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
        para.Inlines.Add(new Run { Text = InlineText(p.Inline) });
        return para;
    }

    private static Paragraph RenderBullet(ParagraphBlock p)
    {
        var para = new Paragraph { Margin = new Thickness(16, 0, 0, 0) };
        para.Inlines.Add(new Run { Text = "\u2022  " + InlineText(p.Inline) });
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
