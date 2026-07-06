/**
 * The system/core versions the statblock→actor conversion was last verified
 * against (schema fixtures in test/fixtures/dnd5e-53-schema/ were extracted
 * from this exact install; M6 live verification runs against it).
 */
export const TESTED_COMPAT = {
  dnd5e: "5.3.3",
  foundryCore: "14.364",
  fixturesExtracted: "2026-07-06",
} as const;
