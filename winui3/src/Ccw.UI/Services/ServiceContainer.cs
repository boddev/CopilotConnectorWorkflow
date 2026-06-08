using System;
using System.Collections.Generic;
using Ccw.Core.Compare;
using Ccw.Core.Jobs;
using Ccw.UI.ViewModels;

namespace Ccw.UI.Services;

/// <summary>Builds the minimal service container. v1 just maps Type→instance.
/// Replace with Microsoft.Extensions.DependencyInjection when service
/// count crosses ~10 (today it's six).</summary>
internal static class ServiceContainer
{
    public static IReadOnlyDictionary<Type, object> Build()
    {
        var nav = new NavigationService();
        var theme = new ThemeService();
        var jobs = new JobService();
        var diagnostics = new DiagnosticsService();
        var markdown = new MarkdownReportRenderer();
        var fileRouter = new FileActivationRouter(nav, jobs);

        return new Dictionary<Type, object>
        {
            [typeof(NavigationService)] = nav,
            [typeof(ThemeService)] = theme,
            [typeof(JobService)] = jobs,
            [typeof(DiagnosticsService)] = diagnostics,
            [typeof(MarkdownReportRenderer)] = markdown,
            [typeof(FileActivationRouter)] = fileRouter,
        };
    }
}
