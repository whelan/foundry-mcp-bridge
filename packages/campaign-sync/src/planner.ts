import { questProgressHash } from "./fql.js";
import type { Manifest, RepoEntity, LiveState, Plan, PlanItem, AssetAction } from "./types.js";

export function computePlan(manifest: Manifest, repo: RepoEntity[], live: LiveState): Plan {
  const matches = live.world.id === manifest.world.id;
  if (!matches) {
    return { world: { id: manifest.world.id, matches: false }, blocked: true, items: [] };
  }

  const items: PlanItem[] = [];
  for (const e of repo) {
    const m = manifest.entities[e.source];
    const l = m ? live.docs[m.foundryId] : undefined;
    const assets = planAssets(e, m?.assets ?? []);
    const base = { source: e.source, documentType: e.documentType, foundryId: m?.foundryId, contentHash: e.contentHash, assets };

    if (e.documentType === "Quest") {
      items.push(planQuest(e, m, l, base));
      continue;
    }

    if (!m) {
      items.push({ ...base, action: "create", reason: "no manifest entry" });
    } else if (!l) {
      items.push({ ...base, action: "missing-remote", reason: "id not found in world" });
    } else {
      const localChanged = e.contentHash !== m.contentHash;
      const remoteChanged = l.modifiedTime !== m.remoteModifiedTime;
      if (!localChanged && !remoteChanged) items.push({ ...base, action: "unchanged", reason: "in sync" });
      else if (localChanged && !remoteChanged) items.push({ ...base, action: "update", reason: "repo changed" });
      else if (!localChanged && remoteChanged) items.push({ ...base, action: "remote-ahead", reason: "world changed (Foundry wins)" });
      else items.push({ ...base, action: "conflict", reason: "both changed (Foundry wins → skip)" });
    }
  }
  return { world: { id: manifest.world.id, matches: true }, blocked: false, items: order(items) };
}

function planAssets(e: RepoEntity, recorded: { localPath: string; contentHash: string }[]) {
  return e.assets.map((a) => {
    const prev = recorded.find((r) => r.localPath === a.localPath);
    const action: AssetAction = !prev ? "upload" : prev.contentHash !== a.contentHash ? "reupload" : "unchanged";
    return { localPath: a.localPath, action };
  });
}

// Quest planning; documents path is complete here. Quest tests are added in a later task.
function planQuest(
  e: RepoEntity,
  m: Manifest["entities"][string] | undefined,
  l: LiveState["docs"][string] | undefined,
  base: Omit<PlanItem, "action" | "reason">,
): PlanItem {
  const progressHash = l?.quest ? questProgressHash(l.quest) : undefined;
  if (!m) return { ...base, action: "create", reason: "no manifest entry", progressHash };
  if (!l) return { ...base, action: "missing-remote", reason: "quest id not found in world" };
  const structureChanged = e.contentHash !== m.contentHash;
  const progressChanged = progressHash !== undefined ? progressHash !== m.progressHash : false;
  if (structureChanged && progressChanged) return { ...base, action: "quest-push-and-pull", reason: "structure + progress changed", progressHash };
  if (structureChanged) return { ...base, action: "quest-push-structure", reason: "structure changed", progressHash };
  if (progressChanged) return { ...base, action: "quest-pull-progress", reason: "progress changed (pull)", progressHash };
  return { ...base, action: "unchanged", reason: "in sync", progressHash };
}

const RANK: Record<string, number> = {
  create: 0,
  update: 1,
  "quest-push-structure": 1,
  "quest-push-and-pull": 1,
  "quest-pull-progress": 2,
  "remote-ahead": 3,
  conflict: 3,
  "missing-remote": 3,
  unchanged: 4,
};

function order(items: PlanItem[]): PlanItem[] {
  return [...items].sort(
    (a, b) => (RANK[a.action] ?? 9) - (RANK[b.action] ?? 9) || a.source.localeCompare(b.source),
  );
}

export function planToTable(plan: Plan): string {
  if (plan.blocked) {
    return `BLOCKED: world mismatch — manifest is for "${plan.world.id}", live world is different. No writes.`;
  }
  const rows = plan.items.map((i) => {
    const assets = i.assets.filter((a) => a.action !== "unchanged").map((a) => `${a.action}:${a.localPath}`).join(", ");
    return `| ${i.action} | ${i.documentType} | ${i.source} | ${i.reason} | ${assets} |`;
  });
  return ["| action | type | source | reason | assets |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}
