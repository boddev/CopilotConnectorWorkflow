using Ccw.UI.Services;
using Ccw.UI.ViewModels;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;

namespace Ccw.UI.Views;

public sealed partial class WizardPage : Page
{
    public WizardViewModel ViewModel { get; }

    public WizardPage()
    {
        ViewModel = new WizardViewModel(App.GetService<BootstrapOrchestrator>());
        InitializeComponent();
    }

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        await ViewModel.RefreshAsync();
    }
}
