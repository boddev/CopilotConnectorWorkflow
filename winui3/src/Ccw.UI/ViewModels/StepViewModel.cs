using System;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using Ccw.Core.Models;

namespace Ccw.UI.ViewModels;

/// <summary>One pipeline stage row on the job detail page. Carries the live status,
/// timing, captured output text, and any error for a single step so the user gets
/// per-stage feedback while the pipeline runs.</summary>
public partial class StepViewModel : ObservableObject
{
    public StepViewModel(StepName step)
    {
        Step = step;
        Name = Label(step);
    }

    public StepName Step { get; }

    [ObservableProperty] public partial string Name { get; set; }
    [ObservableProperty] public partial string Status { get; set; } = "\u23F3 Pending";
    [ObservableProperty] public partial string Timing { get; set; } = "";
    [ObservableProperty] public partial string Output { get; set; } = "";
    [ObservableProperty] public partial bool HasOutput { get; set; }
    [ObservableProperty] public partial string ErrorMessage { get; set; } = "";
    [ObservableProperty] public partial bool HasError { get; set; }

    public void AppendOutput(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        Output += text;
        HasOutput = Output.Length > 0;
    }

    public void Reset()
    {
        Output = "";
        HasOutput = false;
        ErrorMessage = "";
        HasError = false;
    }

    public void UpdateFrom(StepRecord rec)
    {
        Status = StatusGlyph(rec.Status);
        ErrorMessage = rec.ErrorMessage ?? "";
        HasError = !string.IsNullOrEmpty(rec.ErrorMessage);
        Timing = BuildTiming(rec);
    }

    private static string BuildTiming(StepRecord rec)
    {
        if (rec.Status == StepStatus.Running) return "running\u2026";
        if (!string.IsNullOrEmpty(rec.StartedAt) && !string.IsNullOrEmpty(rec.EndedAt)
            && DateTimeOffset.TryParse(rec.StartedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var start)
            && DateTimeOffset.TryParse(rec.EndedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var end))
        {
            var secs = (end - start).TotalSeconds;
            return secs >= 0 ? string.Format(CultureInfo.InvariantCulture, "{0:0.0}s", secs) : "";
        }
        return "";
    }

    public static string StatusGlyph(StepStatus status) => status switch
    {
        StepStatus.Pending => "\u23F3 Pending",
        StepStatus.Running => "\u25B6 Running",
        StepStatus.Done => "\u2713 Done",
        StepStatus.Failed => "\u2717 Failed",
        StepStatus.Skipped => "\u2013 Skipped",
        _ => status.ToString(),
    };

    private static string Label(StepName step) => step switch
    {
        StepName.EvalGen => "1. Eval generation",
        StepName.Enhance => "2. Enhance",
        StepName.Schema => "3. Schema",
        StepName.Connector => "4. Connector",
        StepName.Deploy => "5. Deploy",
        StepName.Score => "6. Score",
        _ => step.ToString(),
    };
}
