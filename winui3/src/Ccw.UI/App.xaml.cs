using System;
using System.Collections.Generic;
using System.Diagnostics;
using Ccw.UI.Services;
using Ccw.UI.Views;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Ccw.UI;

/// <summary>
/// App lifetime. Owns the single ShellWindow + the service container.
/// </summary>
public partial class App : Application
{
    private static App? s_current;
    private ShellWindow? _shell;

    public App()
    {
        s_current = this;
        InitializeComponent();
        UnhandledException += OnUnhandledException;
        Services = ServiceContainer.Build();
    }

    /// <summary>The minimal service container — no DI framework needed
    /// for a v1 head this small. Replace with Microsoft.Extensions.DI
    /// once it gets more services than fit on one screen.</summary>
    public IReadOnlyDictionary<Type, object> Services { get; }

    public ShellWindow? Shell => _shell;

    public static T GetService<T>() where T : class
    {
        if (s_current is null)
            throw new InvalidOperationException("App not constructed yet.");
        return (T)s_current.Services[typeof(T)];
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _shell = new ShellWindow();
        _shell.Activate();

        // Handle the cold-start activation (file open / protocol etc.).
        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        RouteActivation(activation);
    }

    /// <summary>Called by Program.cs on every re-activation (a 2nd
    /// process redirected its args to us). Marshal to the UI thread —
    /// the AppLifecycle event arrives on a worker thread.</summary>
    public static void OnReactivation(object? sender, AppActivationArguments e)
    {
        var app = s_current ?? throw new InvalidOperationException("App not constructed yet.");
        var dq = app._shell?.DispatcherQueue;
        if (dq is null) { app.RouteActivation(e); return; }
        dq.TryEnqueue(DispatcherQueuePriority.Normal, () =>
        {
            app._shell?.BringToFront();
            app.RouteActivation(e);
        });
    }

    private void RouteActivation(AppActivationArguments? args)
    {
        if (args is null) return;
        try
        {
            // .ccwjob file association (plan §5g). Optional FTA in v1.
            if (args.Kind == ExtendedActivationKind.File &&
                args.Data is Windows.ApplicationModel.Activation.IFileActivatedEventArgs fileArgs)
            {
                var router = GetService<FileActivationRouter>();
                router.Handle(fileArgs);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"RouteActivation failed: {ex}");
        }
    }

    private static void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        Debug.WriteLine($"Unhandled: {e.Exception}");
        // Surface but don't crash — WinUI's default would terminate.
        e.Handled = true;
    }
}
