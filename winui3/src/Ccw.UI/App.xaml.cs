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
///
/// Phase 5 reviewer fold-in (Opus I1 + GPT B1): re-activations can arrive
/// before the shell exists. We capture the UI dispatcher in
/// <see cref="UiDispatcher"/> from <see cref="Program.Main"/>, queue
/// activations into <see cref="_pendingActivations"/> while the shell
/// is null, and drain them after <see cref="OnLaunched"/> activates
/// the shell — always marshaled onto the UI thread.
/// </summary>
public partial class App : Application
{
    private static App? s_current;
    private static readonly Queue<AppActivationArguments> _pendingActivations = new();
    private static readonly object _pendingLock = new();
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

    /// <summary>UI dispatcher captured by <see cref="Program.Main"/>
    /// before the shell is constructed, so re-activations that race
    /// startup can still marshal back to the UI thread.</summary>
    public static DispatcherQueue? UiDispatcher { get; internal set; }

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

        // Drain any reactivations that arrived during cold-start.
        DrainPendingActivations();
    }

    /// <summary>Called by Program.cs on every re-activation (a 2nd
    /// process redirected its args to us). Always marshals to the UI
    /// thread — if the shell isn't ready yet, the activation is
    /// queued and drained from <see cref="OnLaunched"/>.</summary>
    public static void OnReactivation(object? sender, AppActivationArguments e)
    {
        var app = s_current;
        if (app is null || app._shell is null)
        {
            lock (_pendingLock) _pendingActivations.Enqueue(e);
            return;
        }
        var dq = app._shell.DispatcherQueue ?? UiDispatcher;
        if (dq is null)
        {
            lock (_pendingLock) _pendingActivations.Enqueue(e);
            return;
        }
        dq.TryEnqueue(DispatcherQueuePriority.Normal, () =>
        {
            app._shell?.BringToFront();
            app.RouteActivation(e);
        });
    }

    private void DrainPendingActivations()
    {
        var dq = _shell?.DispatcherQueue ?? UiDispatcher;
        List<AppActivationArguments> snapshot;
        lock (_pendingLock)
        {
            if (_pendingActivations.Count == 0) return;
            snapshot = new List<AppActivationArguments>(_pendingActivations);
            _pendingActivations.Clear();
        }
        foreach (var args in snapshot)
        {
            if (dq is null)
            {
                RouteActivation(args);
            }
            else
            {
                var captured = args;
                dq.TryEnqueue(DispatcherQueuePriority.Normal, () =>
                {
                    _shell?.BringToFront();
                    RouteActivation(captured);
                });
            }
        }
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
        // Phase 5 reviewer (Opus N1): re-throw under debugger so hard bugs surface.
        if (Debugger.IsAttached) return;
        e.Handled = true;
    }
}
