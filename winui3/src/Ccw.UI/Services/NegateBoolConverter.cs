using System;
using Microsoft.UI.Xaml.Data;

namespace Ccw.UI.Services;

/// <summary>Boolean inverter for XAML bindings (e.g. "enabled when not busy").
/// Trivial — kept here instead of a separate Converters folder.</summary>
public sealed class NegateBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        if (value is bool b) return !b;
        return true;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language)
    {
        if (value is bool b) return !b;
        return false;
    }
}
