import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  indexFileProblems,
  indexFileProblemsV3,
  indexFileProblemsV4,
  needsVersion3,
  needsVersion4,
} from "./index-files.mjs";

const plugin = { type: "plugin", id: "parking-share", version: "1.0.0" };
const withRoutes = {
  ...plugin,
  id: "parking-share-residents",
  residentRoutes: [{ path: "offers", title: { sv: "Erbjud", en: "Offer" } }],
};

test("a plugin entry needs version 3 by carrying residentRoutes, an empty list included", () => {
  assert.equal(needsVersion3(plugin), false);
  assert.equal(needsVersion3(withRoutes), true);
  assert.equal(needsVersion3({ ...plugin, residentRoutes: [] }), true);
  assert.equal(
    needsVersion3({ type: "theme", id: "t", residentRoutes: [] }),
    false,
  );
});

test("version 3 lists the entries of version 2 unchanged", () => {
  assert.deepEqual(indexFileProblemsV3([plugin], [plugin]), []);
  assert.deepEqual(indexFileProblemsV3([], []), []);
});

test("version 3 may list an entry that needs it, and version 2 may not", () => {
  assert.deepEqual(indexFileProblemsV3([], [withRoutes]), []);
  assert.deepEqual(indexFileProblemsV3([plugin], [plugin, withRoutes]), []);
  assert.deepEqual(indexFileProblemsV3([withRoutes], [withRoutes]), [
    "catalog-v2.json lists parking-share-residents, which needs version 3 of the index",
  ]);
});

test("version 3 may not drop or change an entry version 2 lists", () => {
  assert.deepEqual(indexFileProblemsV3([plugin], []), [
    "catalog-v3.json does not list parking-share the same as catalog-v2.json",
  ]);
  assert.deepEqual(
    indexFileProblemsV3([plugin], [{ ...plugin, version: "1.0.1" }]),
    [
      "catalog-v3.json does not list parking-share the same as catalog-v2.json",
      "catalog-v3.json lists parking-share, which catalog-v2.json does not list the same, and which does not need version 3",
    ],
  );
});

test("version 3 may not list an entry version 2 does not, unless it needs version 3", () => {
  assert.deepEqual(indexFileProblemsV3([], [plugin]), [
    "catalog-v3.json lists parking-share, which catalog-v2.json does not list the same, and which does not need version 3",
  ]);
});

const withCallers = {
  ...withRoutes,
  id: "parking-share-everyone",
  nonResidentCallers: ["board"],
};
const collection = {
  collection: "claims",
  titleKey: "records.claims.title",
  personalData: ["name"],
  keepAtMostDays: 730,
  fields: [],
};

test("a plugin entry needs version 4 by carrying nonResidentCallers or a collection's showsSubject", () => {
  assert.equal(needsVersion4(plugin), false);
  assert.equal(needsVersion4(withRoutes), false);
  assert.equal(needsVersion4(withCallers), true);
  assert.equal(needsVersion4({ ...plugin, personRecords: [collection] }), false);
  assert.equal(
    needsVersion4({
      ...plugin,
      personRecords: [collection, { ...collection, showsSubject: true }],
    }),
    true,
  );
  assert.equal(
    needsVersion4({
      ...plugin,
      personRecords: [{ ...collection, showsSubject: false }],
    }),
    true,
  );
  assert.equal(
    needsVersion4({ type: "theme", id: "t", nonResidentCallers: ["board"] }),
    false,
  );
});

test("version 4 lists the entries of version 3 unchanged, and may add one that needs it", () => {
  assert.deepEqual(
    indexFileProblemsV4([plugin, withRoutes], [plugin, withRoutes]),
    [],
  );
  assert.deepEqual(
    indexFileProblemsV4([plugin, withRoutes], [plugin, withRoutes, withCallers]),
    [],
  );
});

test("version 3 may not list an entry that needs version 4", () => {
  assert.deepEqual(indexFileProblemsV4([withCallers], [withCallers]), [
    "catalog-v3.json lists parking-share-everyone, which needs version 4 of the index",
  ]);
});

test("version 4 may not drop or change an entry version 3 lists, or add one that does not need it", () => {
  assert.deepEqual(indexFileProblemsV4([withRoutes], []), [
    "catalog-v4.json does not list parking-share-residents the same as catalog-v3.json",
  ]);
  assert.deepEqual(indexFileProblemsV4([], [withRoutes]), [
    "catalog-v4.json lists parking-share-residents, which catalog-v3.json does not list the same, and which does not need version 4",
  ]);
});

test("the pair of version 1 and 2 keeps its rules", () => {
  const processing = { ...plugin, processing: {} };
  assert.deepEqual(indexFileProblems([processing], [processing]), [
    "catalog.json lists parking-share, which needs version 2 of the index",
  ]);
  assert.deepEqual(indexFileProblems([], [processing]), []);
});

test("the files in this repository agree", async () => {
  const entries = async (file) =>
    JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
      .entries;
  const [v1, v2, v3, v4] = await Promise.all(
    ["catalog.json", "catalog-v2.json", "catalog-v3.json", "catalog-v4.json"].map(
      entries,
    ),
  );
  assert.deepEqual(indexFileProblems(v1, v2), []);
  assert.deepEqual(indexFileProblemsV3(v2, v3), []);
  assert.deepEqual(indexFileProblemsV4(v3, v4), []);
});
