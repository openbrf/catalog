/**
 * The JSON file reader, offline: files made in a temporary directory. Run with
 * `node --test check/`.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { promisify } from "node:util";

import { MAX_JSON_BYTES, readJson } from "./json-file.mjs";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = fs;
const run = promisify(execFile);
const jsonFileUrl = new URL("./json-file.mjs", import.meta.url).href;

const dir = mkdtempSync(join(tmpdir(), "catalog-json-file-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fileWith = (name, content) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

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
    await assert.rejects(readJson(path, 100), {
      message: `${path} is over the 100 byte limit.`,
    });
  });

  it("refuses a file that grew past the limit after it was measured", async () => {
    const path = fileWith("grew.json", stringOfBytes(101));
    // The file handle reports the size it had before it grew.
    const realOpen = fsPromises.open;
    mock.method(fsPromises, "open", async (...args) => {
      const file = await realOpen(...args);
      file.stat = async () => ({ isFile: () => true, size: 10 });
      return file;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(readJson(path, 100), {
        message: `${path} is over the 100 byte limit.`,
      });
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
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
      // A child process, killed after the deadline: a reader blocked in open()
      // would otherwise keep this process alive after the test had failed.
      const script = `
        import { readJson } from ${JSON.stringify(jsonFileUrl)};
        readJson(${JSON.stringify(path)}).then(
          () => console.log("read"),
          (error) => console.log(error.message),
        );
      `;
      const { stdout } = await run(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 5000, killSignal: "SIGKILL" },
      );
      assert.equal(stdout.trim(), `${path} is not a regular file.`);
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
