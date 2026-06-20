import type { DocumentType } from "@foundry-mcp-bridge/shared";

/** Importable Foundry document types plus the logical FQL-backed Quest. */
export type EntityType = DocumentType | "Quest";

export interface AssetRecord {
  localPath: string;
  contentHash: string;
  remotePath: string;
}

export interface ManifestEntity {
  documentType: EntityType;
  foundryId: string;
  contentHash: string;
  remoteModifiedTime: number;
  /** Quests only: hash of pulled progress fields. */
  progressHash?: string;
  lastImportedAt: string;
  assets: AssetRecord[];
}

export interface Manifest {
  version: 1;
  world: { id: string; system: string; forge: boolean };
  /** Keyed by repo-relative source path. */
  entities: Record<string, ManifestEntity>;
}

/** A repo-side note after parsing + hashing. */
export interface RepoEntity {
  source: string;
  documentType: EntityType;
  contentHash: string;
  assets: { localPath: string; contentHash: string }[];
}

/** Live FQL quest progress, parsed from the JournalEntry flag. */
export interface QuestState {
  status: string;
  tasks: { name: string; completed: boolean; failed: boolean }[];
  dateStart: number | null;
  dateEnd: number | null;
}

/** A live Foundry document, keyed by foundryId in LiveState.docs. */
export interface LiveDoc {
  foundryId: string;
  modifiedTime: number;
  /** Present only for quests. */
  quest?: QuestState;
}

export interface LiveState {
  world: { id: string };
  docs: Record<string, LiveDoc>;
}

export type PlanAction =
  | "create"
  | "update"
  | "unchanged"
  | "remote-ahead"
  | "conflict"
  | "missing-remote"
  | "quest-push-structure"
  | "quest-pull-progress"
  | "quest-push-and-pull";

export type AssetAction = "upload" | "reupload" | "unchanged";

export interface PlanItem {
  source: string;
  documentType: EntityType;
  action: PlanAction;
  foundryId?: string;
  reason: string;
  assets: { localPath: string; action: AssetAction }[];
}

export interface Plan {
  world: { id: string; matches: boolean };
  blocked: boolean;
  items: PlanItem[];
}
