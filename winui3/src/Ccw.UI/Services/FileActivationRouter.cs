using System;
using System.IO;
using Ccw.UI.ViewModels;
using Ccw.UI.Views;
using Windows.ApplicationModel.Activation;

namespace Ccw.UI.Services;

/// <summary>Routes a `.ccwjob` file activation to a JobDetail navigation.
/// v1 the `.ccwjob` FTA is registered as commented-out in the manifest,
/// so this path only fires when the user manually associates the
/// extension or runs the app with a file argument from a dev launcher.</summary>
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
        // A .ccwjob file is just a tiny JSON pointer: {"jobId":"<id>"}.
        // For v1 we treat the file name (sans extension) as the jobId fallback.
        var jobId = Path.GetFileNameWithoutExtension(path);
        if (string.IsNullOrEmpty(jobId)) return;
        if (_jobs.Load(jobId) is null) return;
        _nav.Navigate(typeof(JobDetailPage), jobId);
    }
}
