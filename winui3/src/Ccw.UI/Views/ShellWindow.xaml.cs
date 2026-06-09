using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI;
using WinRT.Interop;

namespace Ccw.UI.Views;

public sealed partial class ShellWindow : Window
{
    public ShellWindow()
    {
        InitializeComponent();

        // Mica backdrop per plan §5a. Falls back silently on older OS.
        try { SystemBackdrop = new MicaBackdrop(); } catch { }

        RootFrame.Navigate(typeof(MainShell));
    }

    public void BringToFront()
    {
        AppWindow.Show();
        // Best-effort focus restore. Doesn't fight system focus rules
        // (those reject programmatic foreground; see SetForegroundWindow docs).
        var hwnd = WindowNative.GetWindowHandle(this);
        _ = hwnd; // reserved for SetForegroundWindow if a tray icon ships later.
    }
}
