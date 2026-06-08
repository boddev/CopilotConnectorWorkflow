using System;
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
        try
        {
            // RefreshAsync has its own try/catch; the outer catch here
            // guards against the rare case where the dispatcher fails
            // before the Task even runs (Phase 6 reviewer GPT I4).
            await ViewModel.RefreshAsync();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"WizardPage.OnNavigatedTo: {ex}");
        }
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        // Cancel any in-flight install/clone when the user leaves the
        // page (Phase 6 reviewer Opus I2, GPT I5).
        ViewModel.Cancel();
        ViewModel.Dispose();
        base.OnNavigatedFrom(e);
    }
}
