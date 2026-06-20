import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hashContent } from "./hash.js";
import type { EntityType } from "./types.js";

/** Front-matter keys owned by the live world (pulled in), excluded from the content hash. */
export const MANAGED_KEYS = ["status", "tasks"] as const;

export type TypeMap = { prefix: string; type: EntityType }[];

export const DEFAULT_TYPE_MAP: TypeMap = [
  { prefix: "generated/journals/", type: "JournalEntry" },
  { prefix: "generated/npcs/", type: "Actor" },
  { prefix: "generated/scenes/", type: "Scene" },
  { prefix: "generated/quests/", type: "Quest" },
];

export function classifyType(source: string, map: TypeMap): EntityType | undefined {
  return map.find((m) => source.startsWith(m.prefix))?.type;
}

export interface ParsedNote {
  source: string;
  documentType: EntityType;
  frontMatter: Record<string, unknown>;
  body: string;
  contentHash: string;
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseNote(source: string, raw: string, map: TypeMap): ParsedNote {
  const documentType = classifyType(source, map) ?? "JournalEntry";
  // Normalize CRLF → LF up front so front-matter detection and the content hash
  // are identical whether the notes repo is checked out with LF or CRLF endings.
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = FM_RE.exec(normalized);
  const fmRaw = match ? match[1] : undefined;
  const bodyRaw = match ? match[2] : undefined;
  const frontMatter = fmRaw ? ((parseYaml(fmRaw) as Record<string, unknown>) ?? {}) : {};
  const body = bodyRaw ?? normalized;

  // Hash authored content only: front-matter minus MANAGED_KEYS, plus body.
  const authored: Record<string, unknown> = { ...frontMatter };
  for (const k of MANAGED_KEYS) delete authored[k];
  const contentHash = hashContent(stringifyYaml(authored) + "\n---\n" + body);

  return { source, documentType, frontMatter, body, contentHash };
}
