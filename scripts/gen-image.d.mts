// Hand-written declarations for the pure, exported helpers in gen-image.mjs
// (the repo compiles without allowJs, and the script must stay plain .mjs so
// it runs with bare node). Keep in sync with the exports in gen-image.mjs.

export interface GenImageArgs {
  prompt?: string;
  out?: string;
  name?: string;
  "out-dir"?: string;
  width?: string;
  height?: string;
  [key: string]: unknown;
}

export interface ProjectConfig {
  outputDir?: string;
  codex?: { model?: string };
}

export interface ImageDirEntry {
  name: string;
  mtimeMs: number;
}

export declare function buildCodexPrompt(args: GenImageArgs): string;

export declare function parseCodexSessionId(lines: string[]): string | null;

export declare function pickGeneratedImage(entries: ImageDirEntry[]): {
  chosen: ImageDirEntry | null;
  extras: ImageDirEntry[];
};

export declare function resolveOutPath(
  args: GenImageArgs,
  config: ProjectConfig | null,
  env: Record<string, string | undefined>,
  cwd: string,
): string | null;
