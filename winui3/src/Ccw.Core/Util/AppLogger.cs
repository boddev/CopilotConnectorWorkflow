using System;
using System.IO;
using System.Runtime.CompilerServices;

namespace Ccw.Core.Util;

public static class AppLogger
{
    public static void Log(string message, Exception? exception = null, [CallerMemberName] string? caller = null)
    {
        try
        {
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CopilotConnectorWorkflow",
                "logs");
            Directory.CreateDirectory(root);

            var file = Path.Combine(root, $"app-{DateTime.UtcNow:yyyyMMdd}.log");
            var line = $"[{DateTimeOffset.UtcNow:O}] {caller ?? "App"}: {message}";
            if (exception is not null)
            {
                line += Environment.NewLine + exception;
            }

            File.AppendAllText(file, line + Environment.NewLine + Environment.NewLine);
        }
        catch
        {
            // Best-effort logging; never let diagnostics break the app.
        }
    }
}
