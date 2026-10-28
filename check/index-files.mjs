/**
 * How the index files relate: `catalog.json` (version 1), `catalog-v2.json`
 * (version 2) and `catalog-v3.json` (version 3). Pure, so the rules are tested
 * on entries built in memory as well as on the files in this repository.
 */

import { isDeepStrictEqual } from "node:util";

/**
 * The plugin entry fields only version 2 of the index defines. A version 1
 * index that carries one is refused whole, so an entry with any of them is
 * listed in `catalog-v2.json` only. Found by presence, an empty array
 * included, as the schema refuses it either way.
 */
export const VERSION_2_FIELDS = [
  "deviceRoutes",
  "recipients",
  "extensionPoints",
  "extends",
  "processing",
];

/**
 * Whether the entry carries a field that only version 2 defines. A theme's
 * `extends` is its parent, a string that version 1 defines already, so only a
 * plugin's fields are looked for.
 */
export function needsVersion2(entry) {
  return (
    entry.type !== "theme" &&
    VERSION_2_FIELDS.some((field) => Object.hasOwn(entry, field))
  );
}

/**
 * The plugin entry fields only version 3 of the index defines (ADR 0051). A
 * version 2 index that carries one is refused whole, so an entry with any of
 * them is listed in `catalog-v3.json` only. Found by presence, an empty array
 * included, as the schema refuses it either way.
 */
export const VERSION_3_FIELDS = ["residentRoutes"];

/** Whether the entry carries a field that only version 3 defines. */
export function needsVersion3(entry) {
  return (
    entry.type !== "theme" &&
    VERSION_3_FIELDS.some((field) => Object.hasOwn(entry, field))
  );
}

/** Whether two entries hold the same values, whatever the order of their keys. */
const sameEntry = (a, b) => isDeepStrictEqual(a, b);

/**
 * What is wrong with an older index and the next one, each given as its file
 * name and entries: the older carries nothing that needs the newer version, the
 * newer lists every entry of the older unchanged, and lists no other entry
 * unless it needs the newer version.
 */
function pairProblems(older, newer, needsNewer, newerVersion) {
  const olderById = new Map(older.entries.map((entry) => [entry.id, entry]));
  const newerById = new Map(newer.entries.map((entry) => [entry.id, entry]));
  const problems = [];
  for (const entry of older.entries) {
    if (needsNewer(entry)) {
      problems.push(
        `${older.name} lists ${entry.id}, which needs version ${String(newerVersion)} of the index`,
      );
    } else if (!sameEntry(newerById.get(entry.id), entry)) {
      problems.push(
        `${newer.name} does not list ${entry.id} the same as ${older.name}`,
      );
    }
  }
  for (const entry of newer.entries) {
    if (!needsNewer(entry) && !sameEntry(olderById.get(entry.id), entry)) {
      problems.push(
        `${newer.name} lists ${entry.id}, which ${older.name} does not list the same, and which does not need version ${String(newerVersion)}`,
      );
    }
  }
  return problems;
}

/**
 * What is wrong with `catalog.json` and `catalog-v2.json`, each given as its
 * entries: version 1 carries nothing that needs version 2, version 2 lists
 * every entry of version 1 unchanged, and lists no other entry unless it needs
 * version 2.
 */
export function indexFileProblems(v1Entries, v2Entries) {
  return pairProblems(
    { name: "catalog.json", entries: v1Entries },
    { name: "catalog-v2.json", entries: v2Entries },
    needsVersion2,
    2,
  );
}

/**
 * What is wrong with `catalog-v2.json` and `catalog-v3.json`, each given as its
 * entries: version 2 carries nothing that needs version 3, version 3 lists
 * every entry of version 2 unchanged, and lists no other entry unless it needs
 * version 3. Today no entry needs version 3, so the two lists are the same.
 */
export function indexFileProblemsV3(v2Entries, v3Entries) {
  return pairProblems(
    { name: "catalog-v2.json", entries: v2Entries },
    { name: "catalog-v3.json", entries: v3Entries },
    needsVersion3,
    3,
  );
}
