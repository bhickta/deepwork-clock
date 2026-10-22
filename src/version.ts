/**
 * Application version shown in the About dialog.
 *
 * The literal is kept in sync with `package.json` by the integrator. When a Vite
 * `define` for `__APP_VERSION__` is available it wins, otherwise this fallback
 * is used. The `typeof` guard keeps the module valid in any build mode.
 */
declare const __APP_VERSION__: string | undefined;

const FALLBACK_VERSION = "0.2.0-beta.1";

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : FALLBACK_VERSION;

export const APP_NAME = "Deepwork Clock";

export const APP_REPOSITORY = "github.com/bhickta/deepwork-clock";
