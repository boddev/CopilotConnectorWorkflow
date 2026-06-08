using System;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Services;

/// <summary>Thin frame-driver. The MainShell wires its inner Frame in.</summary>
public sealed class NavigationService
{
    private Frame? _frame;

    public void RegisterFrame(Frame frame) => _frame = frame;

    public bool Navigate(Type pageType, object? parameter = null)
    {
        if (_frame is null) return false;
        return _frame.Navigate(pageType, parameter);
    }
}
