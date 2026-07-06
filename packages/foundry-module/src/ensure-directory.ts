/**
 * Unlike `mkdir -p`, Foundry's FilePicker.createDirectory requires the
 * *parent* to already exist — creating "a/b/c" in one call fails if "a/b"
 * isn't there yet — and throws when the directory already exists. Walk the
 * path and create each level in order; per-level errors are ignored (an
 * "already exists" is expected, and a real failure surfaces again, more
 * informatively, on the following upload/browse).
 *
 * Kept behind the narrow DirectoryCreator seam so this is testable in CI
 * without Foundry globals (foundry-runtime.ts itself never runs in CI).
 */
export interface DirectoryCreator {
  createDirectory(source: string, target: string): Promise<unknown>;
}

export async function ensureDirectory(
  fp: DirectoryCreator,
  source: string,
  target: string,
): Promise<void> {
  let path = "";
  for (const segment of target.split("/").filter(Boolean)) {
    path = path ? `${path}/${segment}` : segment;
    try {
      await fp.createDirectory(source, path);
    } catch {
      // already exists (or will fail again, more informatively, on upload/browse)
    }
  }
}
