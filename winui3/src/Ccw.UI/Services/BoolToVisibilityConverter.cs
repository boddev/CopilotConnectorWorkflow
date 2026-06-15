using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;

namespace Ccw.UI.Services;

/// <summary>Maps a bool to <see cref="Visibility"/> for XAML bindings. WinUI 3
/// (unlike UWP) has no implicit bool→Visibility conversion, so visibility bindings
/// must go through a converter. Pass ConverterParameter="Invert" to flip the
/// mapping (true → Collapsed).</summary>
public sealed class BoolToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var flag = value is bool b && b;
        if (IsInvert(parameter)) flag = !flag;
        return flag ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
    {
        var visible = value is Visibility v && v == Visibility.Visible;
        if (IsInvert(parameter)) visible = !visible;
        return visible;
    }

    private static bool IsInvert(object parameter)
        => parameter is string s && string.Equals(s, "Invert", StringComparison.OrdinalIgnoreCase);
}
