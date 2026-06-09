using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Ccw.Core.Util;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using WinRT;

namespace Ccw.UI;

/// <summary>
/// Owns [STAThread] Main so we can register single-instance behavior with
/// <see cref="AppInstance"/> before the XAML runtime spins up. Mirrors
/// the eval-ui-winui3 sibling's pattern (slice 21) — see that codebase
/// for the round-2 reviewer notes that informed the COM-safe redirect.
/// </summary>
internal static class Program
{
    // Bump if we ever want side-by-side installs to coexist as separate windows.
    private const string SingleInstanceKey = "Ccw.UI.SingleInstance.v1";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            AppDomain.CurrentDomain.UnhandledException += OnDomainUnhandledException;
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
            AppDomain.CurrentDomain.FirstChanceException += OnFirstChanceException;

            AppLogger.Log("Startup phase: Main entered");

            ComWrappersSupport.InitializeComWrappers();
            AppLogger.Log("Startup phase: ComWrappers initialized");

            if (!DecideSingleInstance())
            {
                return 0;
            }
            AppLogger.Log("Startup phase: single-instance resolved (primary)");

            Application.Start(static initArgs =>
            {
                try
                {
                    var dispatcher = DispatcherQueue.GetForCurrentThread();
                    App.UiDispatcher = dispatcher;
                    var ctx = new DispatcherQueueSynchronizationContext(dispatcher);
                    System.Threading.SynchronizationContext.SetSynchronizationContext(ctx);
                    _ = new App();
                    AppLogger.Log("Startup phase: App constructed");
                }
                catch (Exception ex)
                {
                    AppLogger.Log("Startup callback failed", ex);
                    Debug.WriteLine($"Startup callback failed: {ex}");
                    throw;
                }
            });
            return 0;
        }
        catch (Exception ex)
        {
            AppLogger.Log("Fatal startup exception", ex);
            Debug.WriteLine($"Fatal: {ex}");
            try { Console.Error.WriteLine(ex); } catch { }
            return 1;
        }
    }

    private static void OnDomainUnhandledException(object sender, System.UnhandledExceptionEventArgs e)
    {
       var ex = e.ExceptionObject as Exception ?? new InvalidOperationException("Unknown unhandled domain exception.");
       AppLogger.Log($"Unhandled domain exception (IsTerminating={e.IsTerminating})", ex);
       Debug.WriteLine($"Unhandled domain exception: {ex}");
    }

    private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
       AppLogger.Log("Unhandled task exception", e.Exception);
       Debug.WriteLine($"Unhandled task exception: {e.Exception}");
       e.SetObserved();
    }

    // Stowed-exception crashes (0xc000027b) tear the process down through the
    // native COM/XAML layer before any managed Unhandled* handler runs, so the
    // only reliable way to capture the real managed stack is at throw time.
    // This is intentionally verbose; it is the breadcrumb trail for the
    // startup crash and is filtered to the noisy-but-bounded probe failures.
    private static void OnFirstChanceException(object? sender, System.Runtime.ExceptionServices.FirstChanceExceptionEventArgs e)
    {
        try
        {
            AppLogger.Log($"FirstChance: {e.Exception.GetType().FullName}: {e.Exception.Message}", e.Exception);
        }
        catch
        {
            // Never let diagnostics recurse into themselves.
        }
    }

    private static bool DecideSingleInstance()
    {
       AppInstance primary = AppInstance.FindOrRegisterForKey(SingleInstanceKey);
        if (primary.IsCurrent)
        {
            primary.Activated += App.OnReactivation;
            return true;
        }
        AppActivationArguments activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        RedirectStaSafe(primary, activation);
        return false;
    }

    private static void RedirectStaSafe(AppInstance primary, AppActivationArguments activation)
    {
        IntPtr redirectEvent = CreateEvent(IntPtr.Zero, true, false, null);
        if (redirectEvent == IntPtr.Zero)
        {
            int lastError = Marshal.GetLastWin32Error();
            Debug.WriteLine($"RedirectStaSafe: CreateEvent failed, lastError={lastError}; falling back to blocking wait.");
            primary.RedirectActivationToAsync(activation).AsTask().GetAwaiter().GetResult();
            return;
        }

        Exception? redirectError = null;
        try
        {
            _ = Task.Run(async () =>
            {
                try { await primary.RedirectActivationToAsync(activation); }
                catch (Exception ex) { redirectError = ex; }
                finally { SetEvent(redirectEvent); }
            });

            const uint CWMO_DEFAULT = 0;
            const uint INFINITE = 0xFFFFFFFF;
            IntPtr[] handles = { redirectEvent };
            int hr = CoWaitForMultipleObjects(CWMO_DEFAULT, INFINITE, (uint)handles.Length, handles, out _);
            if (hr < 0)
            {
                throw Marshal.GetExceptionForHR(hr) ?? new InvalidOperationException($"CoWaitForMultipleObjects failed (HRESULT 0x{hr:X8}).");
            }
        }
        finally { CloseHandle(redirectEvent); }

        if (redirectError is not null) throw redirectError;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEvent(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetEvent(IntPtr hEvent);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ole32.dll")]
    private static extern int CoWaitForMultipleObjects(
        uint dwFlags, uint dwMilliseconds, uint cHandles,
        [In] IntPtr[] pHandles, out uint lpdwIndex);
}
