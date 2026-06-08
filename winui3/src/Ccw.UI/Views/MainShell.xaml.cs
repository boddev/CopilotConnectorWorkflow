using Ccw.UI.Services;
using Microsoft.UI.Xaml.Controls;

namespace Ccw.UI.Views;

public sealed partial class MainShell : Page
{
    public MainShell()
    {
        InitializeComponent();
        var nav = App.GetService<NavigationService>();
        nav.RegisterFrame(ContentFrame);
        ContentFrame.Navigate(typeof(JobsListPage));
        Nav.SelectedItem = Nav.MenuItems[0];
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
            case "diag": ContentFrame.Navigate(typeof(DiagnosticsPage)); break;
        }
    }
}
