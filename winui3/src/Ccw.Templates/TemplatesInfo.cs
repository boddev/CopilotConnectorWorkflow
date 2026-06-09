using System;
using System.IO;

namespace Ccw.Templates;

/// <summary>Locates the runtime templates root directory.
///
/// Templates are shipped as <c>Content</c> alongside the consuming
/// executable (see <c>Ccw.Templates.csproj</c>'s Content include). At
/// runtime they live at <c>&lt;AppContext.BaseDirectory&gt;\templates\</c>
/// — which is correct for both the unpackaged dev build and the MSIX
/// install location, as well as the portable CLI ZIP. Tests can
/// override the lookup via the <c>CCW_TEMPLATES_ROOT</c> environment
/// variable so the parity harness can point at the source-tree
/// <c>templates/</c> directory directly.</summary>
public static class TemplatesInfo
{
    public const string EnvOverride = "CCW_TEMPLATES_ROOT";

    public static string TemplatesRoot
    {
        get
        {
            var overrideRoot = Environment.GetEnvironmentVariable(EnvOverride);
            if (!string.IsNullOrEmpty(overrideRoot) && Directory.Exists(overrideRoot))
                return overrideRoot;
            return Path.Combine(AppContext.BaseDirectory, "templates");
        }
    }

    public static string ConnectorProjectRoot => Path.Combine(TemplatesRoot, "connector-project");

    public static string DeployRoot => Path.Combine(TemplatesRoot, "deploy");
}
