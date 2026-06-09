using Ccw.UI.Services;
using Ccw.UI.ViewModels;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class DiagnosticsPage : Page
{
    public DiagnosticsViewModel ViewModel { get; }

    public DiagnosticsPage()
    {
        InitializeComponent();
        ViewModel = new DiagnosticsViewModel(App.GetService<DiagnosticsService>());
        Loaded += async (_, __) => await ViewModel.RefreshAsync();
    }

    private async void Refresh_Click(object sender, Microsoft.UI.Xaml.RoutedEventArgs e)
        => await ViewModel.RefreshAsync();
}
