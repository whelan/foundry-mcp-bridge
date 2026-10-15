/**
 * The system/core versions the statblock→actor conversion was last verified
 * against (schema fixtures in test/fixtures/dnd5e-605-schema/ were extracted
 * from this exact install; M6 live verification runs against it).
 */
export const TESTED_COMPAT = {
  dnd5e: "6.0.5",
  foundryCore: "14.368",
  fixturesExtracted: "2026-10-15",
} as const;
