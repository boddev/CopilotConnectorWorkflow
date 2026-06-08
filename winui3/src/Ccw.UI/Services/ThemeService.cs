using Microsoft.UI.Xaml;

namespace Ccw.UI.Services;

/// <summary>Centralizes ElementTheme.Default/Light/Dark switching. v1
/// follows the system; user override lands in Settings later.</summary>
public sealed class ThemeService
{
    public ElementTheme Current { get; private set; } = ElementTheme.Default;

    public void Apply(FrameworkElement root, ElementTheme theme)
    {
        Current = theme;
        root.RequestedTheme = theme;
    }
}
