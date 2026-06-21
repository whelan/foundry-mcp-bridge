import { describe, it, expect } from "vitest";
import { extractQuest, questProgressHash, renderProgressFrontMatter } from "./fql.js";

const journalEntry = {
  _id: "508O4p7zIb94Gy1b",
  flags: {
    "forien-quest-log": {
      json: {
        name: "Escape Barovia",
        status: "active",
        tasks: [
          { name: "Find the tome", completed: true, failed: false },
          { name: "Leave the village", completed: false, failed: false },
        ],
        date: { create: 1, start: 2, end: null },
      },
    },
  },
};

describe("fql", () => {
  it("extracts the quest state from a JournalEntry flag", () => {
    const q = extractQuest(journalEntry);
    expect(q.status).toBe("active");
    expect(q.tasks).toHaveLength(2);
    expect(q.tasks[0]).toEqual({ name: "Find the tome", completed: true, failed: false });
    expect(q.dateStart).toBe(2);
    expect(q.dateEnd).toBeNull();
  });

  it("throws loudly on an unrecognized shape", () => {
    expect(() => extractQuest({ _id: "x", flags: {} })).toThrow(/forien-quest-log/);
  });

  it("progress hash changes when a task is checked off", () => {
    const q1 = extractQuest(journalEntry);
    const q2 = { ...q1, tasks: [{ ...q1.tasks[0]! }, { ...q1.tasks[1]!, completed: true }] };
    expect(questProgressHash(q1)).not.toBe(questProgressHash(q2));
  });

  it("renders progress as front-matter fields", () => {
    const q = extractQuest(journalEntry);
    const fm = renderProgressFrontMatter(q);
    expect(fm.status).toBe("active");
    expect(fm.tasks).toEqual([
      { name: "Find the tome", completed: true },
      { name: "Leave the village", completed: false },
    ]);
  });

  it("preserves a failed task flag (only when set)", () => {
    const q = {
      status: "active",
      tasks: [
        { name: "Cross the mists", completed: false, failed: true },
        { name: "Find the gate", completed: false, failed: false },
      ],
      dateStart: null,
      dateEnd: null,
    };
    expect(renderProgressFrontMatter(q).tasks).toEqual([
      { name: "Cross the mists", completed: false, failed: true },
      { name: "Find the gate", completed: false },
    ]);
  });
});
