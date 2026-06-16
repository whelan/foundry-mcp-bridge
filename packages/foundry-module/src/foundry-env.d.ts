/**
 * Minimal ambient declarations for the Foundry browser globals the runtime
 * adapter touches. Intentionally loose (`any`) — the adapter is not run in CI;
 * the tested logic lives in protocol-executor.ts / relay-client.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const game: any;
declare const Hooks: any;
declare const FilePicker: any;
declare const CONFIG: any;
declare const ui: any;
declare function getDocumentClass(name: string): any;
declare const WebSocket: { new (url: string): any };
