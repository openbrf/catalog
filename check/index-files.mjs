/**
 * How the two index files relate: `catalog.json` (version 1) and
 * `catalog-v2.json` (version 2). Pure, so the rules are tested on entries built
 * in memory as well as on the files in this repository.
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

/** Whether two entries hold the same values, whatever the order of their keys. */
const sameEntry = (a, b) => isDeepStrictEqual(a, b);

/**
 * What is wrong with the pair of indexes, each given as its entries: version 1
 * carries nothing that needs version 2, version 2 lists every entry of version
 * 1 unchanged, and lists no other entry unless it needs version 2.
 */
export function indexFileProblems(v1Entries, v2Entries) {
  const v1 = new Map(v1Entries.map((entry) => [entry.id, entry]));
  const v2 = new Map(v2Entries.map((entry) => [entry.id, entry]));
  const problems = [];
  for (const entry of v1Entries) {
    if (needsVersion2(entry)) {
      problems.push(
        `catalog.json lists ${entry.id}, which needs version 2 of the index`,
      );
    } else if (!sameEntry(v2.get(entry.id), entry)) {
      problems.push(
        `catalog-v2.json does not list ${entry.id} the same as catalog.json`,
      );
    }
  }
  for (const entry of v2Entries) {
    if (!needsVersion2(entry) && !sameEntry(v1.get(entry.id), entry)) {
      problems.push(
        `catalog-v2.json lists ${entry.id}, which catalog.json does not list the same, and which does not need version 2`,
      );
    }
  }
  return problems;
}
