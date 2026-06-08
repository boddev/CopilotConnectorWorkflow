namespace Ccw.Core;

/// <summary>
/// Placeholder for Phase 0 scaffold. Real types land in Phase 1a
/// (<c>types.ts</c> -> records) and Phase 1b-1i (hashing, jobs, scoring,
/// dataset, comparator, templating, process, tools).
/// </summary>
public static class CoreInfo
{
    /// <summary>Schema / on-disk format version. Bumped when a Phase 1 slice
    /// changes the shape of <c>job.json</c> or a sibling artifact.</summary>
    public const string SchemaVersion = "0.1.0";
}
