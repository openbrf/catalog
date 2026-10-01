/**
 * The core's own packages, read from a checkout of openbrf/openbrf with its
 * plugin-sdk and theme-tools built: at `.core`, or wherever OPENBRF_CORE
 * points. The check and its tests load them here, so both are held to the same
 * core.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const core = resolve(process.env.OPENBRF_CORE ?? ".core");
const load = (path) => import(pathToFileURL(join(core, path)).href);

export const sdk = await load("packages/plugin-sdk/dist/index.js");
export const themeTools = await load("packages/theme-tools/dist/index.js");
