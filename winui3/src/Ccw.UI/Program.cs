using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
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
            ComWrappersSupport.InitializeComWrappers();

            if (!DecideSingleInstance())
            {
                return 0;
            }

            Application.Start(static initArgs =>
            {
                var dispatcher = DispatcherQueue.GetForCurrentThread();
                App.UiDispatcher = dispatcher;
                var ctx = new DispatcherQueueSynchronizationContext(dispatcher);
                System.Threading.SynchronizationContext.SetSynchronizationContext(ctx);
                _ = new App();
            });
            return 0;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Fatal: {ex}");
            try { Console.Error.WriteLine(ex); } catch { }
            return 1;
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
