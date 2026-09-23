/**
 * Which FilePicker class can actually upload.
 *
 * On Foundry v13+ the configured picker lives at `CONFIG.ux.FilePicker`, and
 * that is where The Forge installs its upload-capable subclass. On a Forge world
 * running v14 the bare global `FilePicker` can still *browse* `forgevtt` but its
 * `upload` resolves with no path, so every upload tool failed with
 * "FilePicker.upload returned no path". Prefer the configured class; fall back
 * to the v13 namespaced implementation, then the legacy global.
 *
 * Takes the globals as an argument so it is testable in CI without Foundry.
 */
export function resolveFilePicker(g: any): any {
  return (
    g?.CONFIG?.ux?.FilePicker ??
    g?.foundry?.applications?.apps?.FilePicker?.implementation ??
    g?.FilePicker
  );
}
