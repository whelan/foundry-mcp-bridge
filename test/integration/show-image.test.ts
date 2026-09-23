import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandError } from "@foundry-mcp-bridge/shared";
import { MockFoundry } from "./mock-foundry.js";
import { MockTransport } from "./mock-transport.js";
import type { ToolOutcome } from "../../packages/mcp-server/src/reliability.js";
import {
  runShowImage,
  runShowImageFile,
  showImageFilename,
  type ShowImageFileArgs,
} from "../../packages/mcp-server/src/tools.js";

function setup() {
  const mock = new MockFoundry();
  const transport = new MockTransport(mock);
  return { mock, transport };
}

function expectErr(out: ToolOutcome, code: CommandError["code"]): void {
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error.code).toBe(code);
}

let dir: string;
let webp: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "show-image-"));
  webp = join(dir, "coffin-shop.webp");
  await writeFile(webp, Buffer.from("RIFF\0\0\0\0WEBPVP8 fake"));
  await writeFile(join(dir, "notes.txt"), "not an image");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const args = (over: Partial<ShowImageFileArgs> = {}): ShowImageFileArgs => ({
  filePath: webp,
  title: "Kistemagerens værksted",
  journal: "Vist ved bordet",
  target: "lob-vault/table-live",
  source: "forgevtt",
  show: true,
  ...over,
});

describe("show_image", () => {
  it("dry-runs, then shows the image exactly once", async () => {
    const { mock, transport } = setup();
    const out = await runShowImage(transport, { src: "a/b.webp", title: "Tser Pool" });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write"]);
    expect(mock.shownImages).toEqual([{ src: "a/b.webp", title: "Tser Pool", uuid: undefined }]);
  });
});

describe("show_image_file", () => {
  it("uploads, files a page in a new journal, and shows it", async () => {
    const { mock, transport } = setup();
    const out = await runShowImageFile(transport, args());
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["read-file", "upload", "journal", "page", "show"]);

    expect(mock.filePicker.uploads).toHaveLength(1);
    expect(mock.filePicker.uploads[0]!.source).toBe("forgevtt");
    expect(mock.filePicker.uploads[0]!.name).toMatch(/^\d{8}-\d{6}-kistemagerens-vaerksted\.webp$/);

    const [journal] = mock.documents("JournalEntry") as Array<Record<string, any>>;
    expect(journal!.name).toBe("Vist ved bordet");
    expect(journal!.ownership).toEqual({ default: 2 });
    const [page] = journal!.pages as Array<Record<string, any>>;
    expect(page).toMatchObject({ name: "Kistemagerens værksted", type: "image", ownership: { default: -1 } });

    const data = (out as { data: Record<string, any> }).data;
    expect(data.src).toBe(page!.src);
    expect(data.pageUuid).toBe(`JournalEntry.${journal!._id}.JournalEntryPage.${page!._id}`);
    expect(data.shown).toBe(true);
    expect(mock.shownImages).toEqual([{ src: page!.src, title: "Kistemagerens værksted", uuid: data.pageUuid }]);
  });

  it("reuses the journal on the next picture", async () => {
    const { mock, transport } = setup();
    await runShowImageFile(transport, args());
    await runShowImageFile(transport, args({ title: "Tser Pool" }));
    const journals = mock.documents("JournalEntry") as Array<Record<string, any>>;
    expect(journals).toHaveLength(1);
    expect(journals[0]!.pages).toHaveLength(2);
    expect(mock.shownImages).toHaveLength(2);
  });

  it("show:false files the page hidden and shows nothing", async () => {
    const { mock, transport } = setup();
    const out = await runShowImageFile(transport, args({ show: false }));
    expect(out.ok).toBe(true);
    expect(out.steps).not.toContain("show");
    const [journal] = mock.documents("JournalEntry") as Array<Record<string, any>>;
    expect((journal!.pages as Array<Record<string, any>>)[0]!.ownership).toEqual({ default: 0 });
    expect(mock.shownImages).toHaveLength(0);
  });

  it("refuses relative paths, non-images and missing files before touching Foundry", async () => {
    const { mock, transport } = setup();
    expectErr(await runShowImageFile(transport, args({ filePath: "coffin-shop.webp" })), "VALIDATION");
    expectErr(await runShowImageFile(transport, args({ filePath: join(dir, "notes.txt") })), "VALIDATION");
    expectErr(await runShowImageFile(transport, args({ filePath: join(dir, "missing.webp") })), "VALIDATION");
    expect(mock.filePicker.uploads).toHaveLength(0);
    expect(mock.documents("JournalEntry")).toHaveLength(0);
  });
});

describe("showImageFilename", () => {
  it("stamps and slugs Danish titles", () => {
    expect(showImageFilename("Ørnens Å — om natten", ".webp", new Date("2026-09-24T19:30:12Z"))).toBe(
      "20260924-193012-oernens-aa-om-natten.webp",
    );
    expect(showImageFilename("!!!", ".png", new Date("2026-09-24T19:30:12Z"))).toBe("20260924-193012-image.png");
  });
});
