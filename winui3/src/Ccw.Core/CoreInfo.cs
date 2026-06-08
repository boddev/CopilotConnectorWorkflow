// Phase 1a landed the real types under Ccw.Core.Models. CoreInfo remains
// only as a build-time anchor for the SchemaVersion constant — bumped
// whenever a Phase 1 slice changes the on-disk shape of job.json or a
// sibling artifact.

namespace Ccw.Core;

public static class CoreInfo
{
    /// <summary>Schema / on-disk format version. Bumped when a Phase 1 slice
    /// changes the shape of <c>job.json</c> or a sibling artifact.</summary>
    public const string SchemaVersion = "0.1.0";
}
