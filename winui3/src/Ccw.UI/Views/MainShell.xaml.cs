using System;
using Ccw.UI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class MainShell : Page
{
    private bool _depsBannerDismissed;

    public MainShell()
    {
        InitializeComponent();
        var nav = App.GetService<NavigationService>();
        nav.RegisterFrame(ContentFrame);
        ContentFrame.Navigate(typeof(JobsListPage));
        Nav.SelectedItem = Nav.MenuItems[0];
        DepsBanner.CloseButtonClick += (_, __) => _depsBannerDismissed = true;
        _ = CheckDependenciesAsync();
    }

    private void Nav_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item) return;
        var tag = item.Tag as string;
        switch (tag)
        {
            case "jobs": ContentFrame.Navigate(typeof(JobsListPage)); break;
            case "new": ContentFrame.Navigate(typeof(NewJobPage)); break;
            case "compare": ContentFrame.Navigate(typeof(ComparePage)); break;
            case "wizard": ContentFrame.Navigate(typeof(WizardPage)); break;
            case "diag": ContentFrame.Navigate(typeof(DiagnosticsPage)); break;
        }
    }

    /// <summary>Phase 6: on every launch, probe deps in the background and
    /// surface the banner if anything is missing. Non-blocking by design.
    /// Phase 6 reviewer fold-ins (Opus I3 + GPT I3):
    ///   - GetOrProbeAsync reuses the wizard's snapshot when the wizard
    ///     already ran a probe, avoiding 16 child processes spawning in
    ///     parallel.
    ///   - If the user dismisses the banner before the probe completes,
    ///     `_depsBannerDismissed` blocks the late open.</summary>
    private async System.Threading.Tasks.Task CheckDependenciesAsync()
    {
        try
        {
            var bootstrap = App.GetService<BootstrapOrchestrator>();
            var probes = await bootstrap.GetOrProbeAsync().ConfigureAwait(true);
            if (_depsBannerDismissed) return;
            if (!BootstrapOrchestrator.AllSatisfied(probes))
            {
                DepsBanner.IsOpen = true;
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Dep probe failed: {ex.Message}");
        }
    }

    private void OpenWizard_Click(object sender, RoutedEventArgs e)
    {
        foreach (var item in Nav.MenuItems)
        {
            if (item is NavigationViewItem nvi && (string?)nvi.Tag == "wizard")
            {
                Nav.SelectedItem = nvi;
                ContentFrame.Navigate(typeof(WizardPage));
                DepsBanner.IsOpen = false;
                _depsBannerDismissed = true;
                return;
            }
        }
    }
}
