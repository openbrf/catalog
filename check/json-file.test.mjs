/**
 * The JSON file reader, offline: files made in a temporary directory. Run with
 * `node --test check/`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { MAX_JSON_BYTES, readJson } from "./json-file.mjs";

const dir = mkdtempSync(join(tmpdir(), "catalog-json-file-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fileWith = (name, content) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

/** Rejects when `promise` is still pending after `ms`, so a hang fails. */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        reject(new Error(`still waiting after ${String(ms)} ms`));
      }, ms).unref(),
    ),
  ]);

/** A JSON string document of exactly `bytes` bytes. */
const stringOfBytes = (bytes) => JSON.stringify("a".repeat(bytes - 2));

describe("readJson", () => {
  it("reads a JSON file", async () => {
    const path = fileWith("small.json", '{"version":1}');
    assert.deepEqual(await readJson(path), { version: 1 });
  });

  it("reads a file of exactly the limit", async () => {
    const content = stringOfBytes(100);
    assert.equal(Buffer.byteLength(content), 100);
    const path = fileWith("at-limit.json", content);
    assert.equal(await readJson(path, 100), "a".repeat(98));
  });

  it("refuses a file one byte over the limit, naming the file", async () => {
    const path = fileWith("over-limit.json", stringOfBytes(101));
    await assert.rejects(
      readJson(path, 100),
      (error) =>
        error.message === `${path} is over the 100 byte limit.` &&
        error.stack.includes("json-file.mjs"),
    );
  });

  it("refuses a file over the default limit", async () => {
    const path = fileWith("huge.json", stringOfBytes(MAX_JSON_BYTES + 1));
    await assert.rejects(readJson(path), /byte limit\.$/);
  });

  it("refuses a directory", async () => {
    const path = join(dir, "a-directory");
    mkdirSync(path);
    await assert.rejects(readJson(path), {
      message: `${path} is not a regular file.`,
    });
  });

  it(
    "refuses a FIFO with no writer instead of waiting for one",
    { skip: process.platform === "win32" },
    async () => {
      const path = join(dir, "pipe.json");
      execFileSync("mkfifo", [path]);
      await within(
        assert.rejects(readJson(path), {
          message: `${path} is not a regular file.`,
        }),
        5000,
      );
    },
  );

  it("refuses a file that is not JSON", async () => {
    const path = fileWith("broken.json", "{");
    await assert.rejects(readJson(path), SyntaxError);
  });

  it("refuses a file that is not there", async () => {
    await assert.rejects(readJson(join(dir, "missing.json")), {
      code: "ENOENT",
    });
  });
});
