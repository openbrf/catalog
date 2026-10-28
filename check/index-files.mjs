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
 * The plugin entry fields only version 3 of the index defines (ADR 0051). A
 * version 2 index that carries one is refused whole, so an entry with any of
 * them is listed in `catalog-v3.json` only. Found by presence, an empty array
 * included, as the schema refuses it either way.
 */
export const VERSION_3_FIELDS = ["residentRoutes"];

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
 * What is wrong with a file and the file of the next version up, each given as
 * its name and entries: the lower carries nothing that needs the higher
 * version, the higher lists every entry of the lower unchanged, and lists no
 * other entry unless it needs the higher version.
 */
function pairProblems(lower, higher, higherVersion, needsHigher) {
  const lowerById = new Map(lower.entries.map((entry) => [entry.id, entry]));
  const higherById = new Map(higher.entries.map((entry) => [entry.id, entry]));
  const problems = [];
  for (const entry of lower.entries) {
    if (needsHigher(entry)) {
      problems.push(
        `${lower.file} lists ${entry.id}, which needs version ${String(higherVersion)} of the index`,
      );
    } else if (!sameEntry(higherById.get(entry.id), entry)) {
      problems.push(
        `${higher.file} does not list ${entry.id} the same as ${lower.file}`,
      );
    }
  }
  for (const entry of higher.entries) {
    if (!needsHigher(entry) && !sameEntry(lowerById.get(entry.id), entry)) {
      problems.push(
        `${higher.file} lists ${entry.id}, which ${lower.file} does not list the same, and which does not need version ${String(higherVersion)}`,
      );
    }
  }
  return problems;
}

/**
 * What is wrong with the pair of indexes, each given as its entries: version 1
 * carries nothing that needs version 2, version 2 lists every entry of version
 * 1 unchanged, and lists no other entry unless it needs version 2.
 */
export function indexFileProblems(v1Entries, v2Entries) {
  return pairProblems(
    { file: "catalog.json", entries: v1Entries },
    { file: "catalog-v2.json", entries: v2Entries },
    2,
    needsVersion2,
  );
}

/**
 * What is wrong with versions 2 and 3, each given as its entries, by the same
 * rules: version 2 carries nothing that needs version 3, version 3 lists every
 * entry of version 2 unchanged, and lists no other entry unless it needs
 * version 3.
 */
export function indexFileProblemsV3(v2Entries, v3Entries) {
  return pairProblems(
    { file: "catalog-v2.json", entries: v2Entries },
    { file: "catalog-v3.json", entries: v3Entries },
    3,
    needsVersion3,
  );
}
