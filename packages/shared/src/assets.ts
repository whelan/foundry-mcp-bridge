/**
 * Asset-path helpers shared across the Forge-aware code paths (the Foundry-module
 * runtime, the mock, and the MCP server's direct Forge REST client) so dedup
 * behaviour is identical everywhere.
 */

/**
 * The filename of an asset path. Strips any query string first, because on The
 * Forge `FilePicker.browse("forgevtt", …)` / the REST API return absolute CDN
 * URLs (with the user-id prefix and `?` query params) rather than the relative
 * `target/filename` we construct — so dedup must compare by basename, not full
 * path, or it would never match and re-upload everything.
 */
export function assetBaseName(path: string): string {
  return (path.split("?")[0] ?? path).split("/").pop() ?? path;
}
