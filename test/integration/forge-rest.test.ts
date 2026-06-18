import { describe, it, expect } from "vitest";
import {
  ForgeRestClient,
  ForgeRestError,
} from "../../packages/mcp-server/src/forge-rest.js";
import {
  runForgeBrowseAssets,
  runForgeUploadAsset,
  runForgeCreateFolder,
} from "../../packages/mcp-server/src/forge-tools.js";

/** Records the last fetch call and returns a canned Response. */
interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  reply: { status?: number; statusText?: string; body?: string },
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(reply.body ?? "", {
      status: reply.status ?? 200,
      statusText: reply.statusText ?? "OK",
    });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const BASE = "https://forge.test/api";
function client(fetchImpl: typeof fetch): ForgeRestClient {
  return new ForgeRestClient({ userId: "u1", apiKey: "secret", baseUrl: BASE, fetchImpl });
}

describe("ForgeRestClient", () => {
  it("requires credentials", () => {
    expect(() => new ForgeRestClient({ userId: "", apiKey: "k" })).toThrow(/userId/);
    expect(() => new ForgeRestClient({ userId: "u", apiKey: "" })).toThrow(/apiKey/);
  });

  it("browseAssets calls the user assets endpoint with the auth header", async () => {
    const { fetch, calls } = fakeFetch({
      body: JSON.stringify({ files: ["a.webp", 1, "b.png"], dirs: ["sub"] }),
    });
    const res = await client(fetch).browseAssets({ path: "worlds/strahd/scenes" });

    expect(res).toEqual({ files: ["a.webp", "b.png"], dirs: ["sub"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${BASE}/user/u1/assets?path=${encodeURIComponent("worlds/strahd/scenes")}`,
    );
    expect(calls[0]!.init?.method).toBe("GET");
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("secret");
  });

  it("browseAssets tolerates a response missing files/dirs", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({}) });
    expect(await client(fetch).browseAssets({ path: "x" })).toEqual({ files: [], dirs: [] });
  });

  it("uploadAsset posts multipart and returns the stored path", async () => {
    const { fetch, calls } = fakeFetch({
      body: JSON.stringify({ path: "worlds/strahd/scenes/village.webp" }),
    });
    const res = await client(fetch).uploadAsset({
      target: "worlds/strahd/scenes",
      filename: "village.webp",
      contentBase64: Buffer.from("hello").toString("base64"),
      mimeType: "image/webp",
    });

    expect(res).toEqual({ path: "worlds/strahd/scenes/village.webp" });
    expect(calls[0]!.url).toBe(`${BASE}/assets/upload`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBeInstanceOf(FormData);
    const form = calls[0]!.init?.body as FormData;
    expect(form.get("target")).toBe("worlds/strahd/scenes");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("uploadAsset throws when the response has no path", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({ ok: true }) });
    await expect(
      client(fetch).uploadAsset({ target: "t", filename: "f", contentBase64: "AA==" }),
    ).rejects.toBeInstanceOf(ForgeRestError);
  });

  it("createFolder PUTs the path and defaults success to true", async () => {
    const { fetch, calls } = fakeFetch({ body: JSON.stringify({}) });
    const res = await client(fetch).createFolder({ path: "worlds/strahd/tokens" });

    expect(res).toEqual({ success: true });
    expect(calls[0]!.url).toBe(`${BASE}/user/u1/assets`);
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ path: "worlds/strahd/tokens" });
  });

  it("surfaces non-2xx as a ForgeRestError carrying the status + parsed details", async () => {
    const { fetch } = fakeFetch({
      status: 404,
      statusText: "Not Found",
      body: JSON.stringify({ error: "no such path" }),
    });
    const e = await client(fetch)
      .browseAssets({ path: "missing" })
      .catch((err) => err);
    expect(e).toBeInstanceOf(ForgeRestError);
    expect((e as ForgeRestError).status).toBe(404);
    expect((e as ForgeRestError).details).toEqual({ error: "no such path" });
  });

  it("rejects a non-JSON 2xx body", async () => {
    const { fetch } = fakeFetch({ body: "<html>nope</html>" });
    await expect(client(fetch).browseAssets({ path: "x" })).rejects.toThrow(/non-JSON/);
  });

  it("times out via the abort signal", async () => {
    const hangingFetch = (async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const c = new ForgeRestClient({
      userId: "u",
      apiKey: "k",
      baseUrl: BASE,
      fetchImpl: hangingFetch,
      timeoutMs: 10,
    });
    await expect(c.browseAssets({ path: "x" })).rejects.toThrow(/timed out/);
  });
});

describe("forge tools → ToolOutcome", () => {
  it("returns UNSUPPORTED when no client is configured", async () => {
    const out = await runForgeBrowseAssets(null, { path: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("UNSUPPORTED");
  });

  it("browse maps success to an ok outcome", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({ files: ["a.webp"], dirs: [] }) });
    const out = await runForgeBrowseAssets(client(fetch), { path: "x" });
    expect(out).toEqual({ ok: true, data: { files: ["a.webp"], dirs: [] }, steps: ["forge-browse-assets"] });
  });

  it("upload maps success to an ok outcome", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({ path: "t/f.webp" }) });
    const out = await runForgeUploadAsset(client(fetch), {
      target: "t",
      filename: "f.webp",
      contentBase64: "AA==",
    });
    expect(out.ok && out.data).toEqual({ path: "t/f.webp" });
  });

  it("create folder maps success to an ok outcome", async () => {
    const { fetch } = fakeFetch({ body: JSON.stringify({ success: true }) });
    const out = await runForgeCreateFolder(client(fetch), { path: "t" });
    expect(out.ok && out.data).toEqual({ success: true });
  });

  it("maps 404 → NOT_FOUND and 401 → AUTH", async () => {
    const notFound = fakeFetch({ status: 404, body: "{}" });
    const o1 = await runForgeBrowseAssets(client(notFound.fetch), { path: "x" });
    expect(o1.ok === false && o1.error.code).toBe("NOT_FOUND");

    const unauthorized = fakeFetch({ status: 401, body: "{}" });
    const o2 = await runForgeBrowseAssets(client(unauthorized.fetch), { path: "x" });
    expect(o2.ok === false && o2.error.code).toBe("AUTH");
  });

  it("maps other failures → INTERNAL", async () => {
    const { fetch } = fakeFetch({ status: 500, body: "{}" });
    const out = await runForgeUploadAsset(client(fetch), {
      target: "t",
      filename: "f",
      contentBase64: "AA==",
    });
    expect(out.ok === false && out.error.code).toBe("INTERNAL");
  });
});

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.[name];
}
