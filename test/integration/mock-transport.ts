/**
 * Transport that drives the mock-foundry, with hooks to exercise the
 * reliability pipeline's failure paths. Shared across integration test files
 * (mcp-tools.test.ts, statblock-import.test.ts) so there is one definition of
 * "what a transport onto MockFoundry looks like", not a copy per test file.
 */

import type { CommandEnvelope } from "@foundry-mcp-bridge/shared";
import type { MockFoundry } from "./mock-foundry.js";
import {
  type RelayTransport,
  type RequestOptions,
  withTimeout,
} from "../../packages/mcp-server/src/relay-transport.js";

export class MockTransport implements RelayTransport {
  corruptReadBack = false;
  /** Fail the Nth `find` (1-indexed) with NOT_FOUND; null disables. Lets tests
   *  target the read-back find specifically (e.g. after an update's pre-read). */
  failFindAtCall: number | null = null;
  /** Strip the Nth `find` result to just `{_id}`, so read-back verification fails
   *  even though the find succeeded (e.g. an embedded change that didn't land). */
  corruptFindAtCall: number | null = null;
  /** Strip quest write echoes to `{_id}`, simulating module normalization — a
   *  content-verify (if it existed) would then false-fail. */
  corruptQuestWrite = false;
  private findCalls = 0;
  constructor(private readonly mock: MockFoundry) {}

  async request(envelope: CommandEnvelope, opts?: RequestOptions) {
    const exec = (async () => {
      const action = envelope.command.action;
      const isFind = action === "find";
      if (isFind) {
        this.findCalls += 1;
        if (this.findCalls === this.failFindAtCall) {
          return {
            id: envelope.id,
            ok: false as const,
            error: { code: "NOT_FOUND" as const, message: "read-back failed" },
          };
        }
      }
      // Clone like the real WebSocket transport serializes results, so callers
      // never alias the mock's live store (e.g. an update's pre-read snapshot).
      const res = structuredClone(await this.mock.execute(envelope));
      const isQuestWrite =
        !envelope.dryRun && (action === "createQuest" || action === "updateQuest");
      const corrupt =
        res.ok &&
        ((isFind && (this.corruptReadBack || this.findCalls === this.corruptFindAtCall)) ||
          (isQuestWrite && this.corruptQuestWrite));
      if (corrupt) {
        this.corruptReadBack = false;
        // Strip everything but the id; a content read-back/verify would fail here.
        return { id: res.id, ok: true as const, data: { _id: (res.data as { _id: string })._id } };
      }
      return res;
    })();
    return opts?.timeoutMs ? withTimeout(exec, opts.timeoutMs) : exec;
  }

  close(): void {}
}
