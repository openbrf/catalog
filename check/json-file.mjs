/**
 * Reads a JSON file from disk for the check: the index files and the
 * repositories file. It touches the filesystem, so it lives here and not in
 * listing.mjs, and the caller reports what it throws.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** The most bytes read of an index file or of the repositories file. */
export const MAX_JSON_BYTES = 1024 * 1024;

const overLimit = (path, maxBytes) =>
  `${path} is over the ${String(maxBytes)} byte limit.`;

/**
 * A JSON file, opened once so that what is measured is what is read, and
 * refused when it is not a regular file or is over `maxBytes`. It is opened
 * without blocking, so that a FIFO with no writer is refused by the file-type
 * check instead of waiting for one; a regular file is unaffected.
 */
export async function readJson(path, maxBytes = MAX_JSON_BYTES) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`${path} is not a regular file.`);
    }
    if (stats.size > maxBytes) {
      throw new Error(overLimit(path, maxBytes));
    }
    // One byte more than the limit, so that a file that grew since the stat is
    // seen to be over it.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new Error(overLimit(path, maxBytes));
    }
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    await file.close();
  }
}
