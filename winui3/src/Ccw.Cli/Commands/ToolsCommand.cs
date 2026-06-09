using Ccw.Core.Tools;

namespace Ccw.Cli.Commands;

internal static class ToolsCommand
{
    public static int Run()
    {
        var status = ToolResolver.Probe();
        foreach (var t in status)
        {
            var mark = t.Ok ? "\u2713" : "\u2717";
            Console.Write(mark);
            Console.Write(' ');
            Console.Write(t.Name.PadRight(28));
            Console.Write(' ');
            Console.WriteLine(t.Path);
            if (!string.IsNullOrEmpty(t.Note))
            {
                Console.WriteLine("     " + t.Note);
            }
        }
        return status.All(t => t.Ok) ? 0 : 1;
    }
}
