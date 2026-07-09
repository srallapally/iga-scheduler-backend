import { createWriteStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import yauzl from "yauzl";
import { isZipEntryDirectory, normalizeZipRelativePath, validateZipEntryPolicy } from "./zipArtifactPolicy.js";

const DEFAULT_MAX_FILE_COUNT = 200;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export async function safeZipExtract(buffer, {
  entrypoint,
  tempRoot = os.tmpdir(),
  prefix = "iga-job-",
  maxFileCount = DEFAULT_MAX_FILE_COUNT,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("zip buffer is required");
  }

  const normalizedEntrypoint = normalizeZipRelativePath(entrypoint, "entrypoint");
  const extractDir = await fs.mkdtemp(path.join(tempRoot, prefix));

  try {
    const result = await extractZipEntries(buffer, { extractDir, maxFileCount, maxUncompressedBytes });
    const entrypointPath = safeJoin(extractDir, normalizedEntrypoint);

    try {
      const stat = await fs.stat(entrypointPath);
      if (!stat.isFile()) {
        throw new Error(`entrypoint is not a file: ${entrypoint}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`entrypoint not found after extraction: ${entrypoint}`);
      }

      throw error;
    }

    return {
      extractDir,
      entrypointPath,
      fileCount: result.fileCount,
      uncompressedBytes: result.uncompressedBytes,
      cleanup: async () => fs.rm(extractDir, { recursive: true, force: true })
    };
  } catch (error) {
    await fs.rm(extractDir, { recursive: true, force: true });
    throw error;
  }
}

function extractZipEntries(buffer, { extractDir, maxFileCount, maxUncompressedBytes }) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) {
        reject(new Error(`invalid zip file: ${openErr.message}`));
        return;
      }

      let fileCount = 0;
      let uncompressedBytes = 0;
      let settled = false;

      function fail(error) {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error);
      }

      function next() {
        if (!settled) zipfile.readEntry();
      }

      zipfile.on("entry", (entry) => {
        let normalizedName;

        try {
          normalizedName = validateZipEntryPolicy(entry.fileName, entry);
        } catch (error) {
          fail(error);
          return;
        }

        const isDirectory = isZipEntryDirectory(entry.fileName);
        fileCount += isDirectory ? 0 : 1;
        uncompressedBytes += entry.uncompressedSize || 0;

        if (fileCount > maxFileCount) {
          fail(new Error(`zip contains more than ${maxFileCount} files`));
          return;
        }

        if (uncompressedBytes > maxUncompressedBytes) {
          fail(new Error(`zip uncompressed size exceeds ${maxUncompressedBytes} bytes`));
          return;
        }

        const targetPath = safeJoin(extractDir, normalizedName);

        if (isDirectory) {
          fs.mkdir(targetPath, { recursive: true }).then(next, fail);
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            fail(new Error(`failed to read zip entry ${entry.fileName}: ${streamErr.message}`));
            return;
          }

          fs.mkdir(path.dirname(targetPath), { recursive: true })
            .then(() => writeStreamToFile(readStream, targetPath))
            .then(next, fail);
        });
      });

      zipfile.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ fileCount, uncompressedBytes });
      });

      zipfile.on("error", (error) => {
        fail(new Error(`zip extraction failed: ${error.message}`));
      });

      next();
    });
  });
}

function writeStreamToFile(readStream, targetPath) {
  return new Promise((resolve, reject) => {
    const writeStream = createWriteStream(targetPath);
    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    readStream.pipe(writeStream);
  });
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`unsafe extraction target: ${relativePath}`);
  }

  return resolvedTarget;
}
