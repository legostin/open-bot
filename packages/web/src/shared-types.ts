// What "@openbot/shared" means to the web app's type checker (tsconfig "paths"): types only.
// The package root also re-exports Node-only modules, so browser code takes runtime values from
// "@openbot/shared/i18n" and "@openbot/shared/avatar" and nothing else from the shared package.
export type * from "../../shared/src/types.ts";
export type * from "../../shared/src/i18n.ts";
export type * from "../../shared/src/avatar.ts";
