/**
 * Generate a stable, URL-safe slug from a statblock name.
 * Used as the canonical identity key for matching actors on re-import
 * and tagging every tool-created item.
 *
 * Examples:
 *   "Test Archmage" → "test-archmage"
 *   "Young Ash Wyrm" → "young-ash-wyrm"
 *   "Liar's Guild" → "liars-guild"
 */
export function statblockKey(name: string): string {
  return (
    name
      .trim() // Remove leading/trailing whitespace
      .toLowerCase() // Convert to lowercase
      .replace(/['']/g, "") // Remove apostrophes
      .replace(/[,]/g, "") // Remove commas
      .replace(/\s+/g, "-") // Collapse whitespace to single hyphens
      .replace(/[^a-z0-9-]/g, "") // Remove all other non-alphanumeric chars (except hyphens)
      .replace(/-+/g, "-") // Collapse multiple hyphens to single
      .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
  );
}
