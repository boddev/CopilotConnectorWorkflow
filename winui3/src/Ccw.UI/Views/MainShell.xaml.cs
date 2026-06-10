using System;
using System.Threading;
using Ccw.Core.Util;
using Ccw.UI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class MainShell : Page
{
    private bool _depsBannerDismissed;
    private CancellationTokenSource? _depsScanCts;

    public MainShell()
    {
        InitializeComponent();
        AppLogger.Log("Startup phase: MainShell.InitializeComponent done");
        var nav = App.GetService<NavigationService>();
        nav.RegisterFrame(ContentFrame);
        ContentFrame.Navigate(typeof(JobsListPage));
        Nav.SelectedItem = Nav.MenuItems[0];
        DepsBanner.CloseButtonClick += (_, __) => _depsBannerDismissed = true;

        // Defer the dependency-CLI scan until the page is in the live visual
        // tree (Loaded fires AFTER the hosting window is activated). Kicking it
        // off from the constructor — which runs during Frame.Navigate, before
        // Window.Activate() — let the post-probe UI mutation (DepsBanner.IsOpen)
        // resume on a not-yet-ready visual tree, producing a stowed COM crash
        // (0xc000027b / E_INVALIDARG in combase). See cross-referenced analysis.
        Loaded += MainShell_Loaded;
        Unloaded += MainShell_Unloaded;
        AppLogger.Log("Startup phase: MainShell ctor done (scan deferred to Loaded)");
    }

    private void MainShell_Loaded(object sender, RoutedEventArgs e)
    {
        AppLogger.Log("Startup phase: MainShell Loaded");
        _depsScanCts ??= new CancellationTokenSource();
        var token = _depsScanCts.Token;
        _ = CheckDependenciesAsync(token);
    }

    private void MainShell_Unloaded(object sender, RoutedEventArgs e)
    {
        try
        {
            _depsScanCts?.Cancel();
            _depsScanCts?.Dispose();
        }
        catch { /* best-effort teardown */ }
        finally { _depsScanCts = null; }
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
    ///
    /// Hardened (cross-referenced with GPT-5.5): the probe runs entirely off
    /// the UI thread (ConfigureAwait(false)); the only UI mutation
    /// (DepsBanner.IsOpen) is marshaled back through the page's DispatcherQueue
    /// and guarded by cancellation + XamlRoot/dismissed lifetime checks, so a
    /// slow or failing CLI scan can never fault the visual tree.
    ///
    /// Phase 6 reviewer fold-ins (Opus I3 + GPT I3):
    ///   - GetOrProbeAsync reuses the wizard's snapshot when the wizard
    ///     already ran a probe, avoiding 16 child processes spawning in
    ///     parallel.
    ///   - If the user dismisses the banner before the probe completes,
    ///     `_depsBannerDismissed` blocks the late open.</summary>
    private async System.Threading.Tasks.Task CheckDependenciesAsync(CancellationToken token)
    {
        try
        {
            AppLogger.Log("Dependency check: starting GetOrProbeAsync");
            var bootstrap = App.GetService<BootstrapOrchestrator>();
            var probes = await bootstrap.GetOrProbeAsync(ct: token).ConfigureAwait(false);
            AppLogger.Log($"Dependency check: probe complete ({probes.Count} results)");

            if (token.IsCancellationRequested) return;
            var missing = !BootstrapOrchestrator.AllSatisfied(probes);

            // Marshal the lone UI mutation back onto the UI thread explicitly,
            // re-checking lifetime once we're there.
            var dq = DispatcherQueue;
            if (dq is null)
            {
                AppLogger.Log("Dependency check: no DispatcherQueue; skipping banner");
                return;
            }
            dq.TryEnqueue(() =>
            {
                try
                {
                    if (token.IsCancellationRequested) return;
                    if (_depsBannerDismissed) return;
                    if (DepsBanner is null || DepsBanner.XamlRoot is null) return;
                    if (missing) DepsBanner.IsOpen = true;
                    AppLogger.Log("Dependency check: banner state applied");
                }
                catch (Exception ex)
                {
                    AppLogger.Log("Dependency check: banner update failed", ex);
                }
            });
        }
        catch (Exception ex)
        {
            AppLogger.Log("Dependency probe failed during startup banner", ex);
            System.Diagnostics.Debug.WriteLine($"Dep probe failed: {ex}");
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
