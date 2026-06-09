using System;
using System.IO;
using System.Text.Json;
using Ccw.UI.ViewModels;
using Ccw.UI.Views;
using Windows.ApplicationModel.Activation;

namespace Ccw.UI.Services;

/// <summary>Routes a `.ccwjob` file activation to a JobDetail navigation.
/// v1 the `.ccwjob` FTA is registered as commented-out in the manifest,
/// so this path only fires when the user manually associates the
/// extension or runs the app with a file argument from a dev launcher.
///
/// Phase 5 reviewer fold-in (Opus I3 + GPT IMPORTANT #3): the file
/// is a JSON pointer `{"jobId":"&lt;id&gt;"}` — parse it; only fall
/// back to the filename stem if parsing fails.</summary>
public sealed class FileActivationRouter
{
    private readonly NavigationService _nav;
    private readonly JobService _jobs;

    public FileActivationRouter(NavigationService nav, JobService jobs)
    {
        _nav = nav;
        _jobs = jobs;
    }

    public void Handle(IFileActivatedEventArgs args)
    {
        if (args.Files.Count == 0) return;
        var first = args.Files[0];
        if (first is null) return;
        var path = first.Path;
        if (string.IsNullOrEmpty(path)) return;
        var jobId = TryReadJobIdFromFile(path) ?? Path.GetFileNameWithoutExtension(path);
        if (string.IsNullOrEmpty(jobId)) return;
        if (_jobs.Load(jobId) is null) return;
        _nav.Navigate(typeof(JobDetailPage), jobId);
    }

    private static string? TryReadJobIdFromFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var stream = File.OpenRead(path);
            using var doc = JsonDocument.Parse(stream);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!doc.RootElement.TryGetProperty("jobId", out var jobIdProp)) return null;
            if (jobIdProp.ValueKind != JsonValueKind.String) return null;
            var value = jobIdProp.GetString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch
        {
            return null;
        }
    }
}
