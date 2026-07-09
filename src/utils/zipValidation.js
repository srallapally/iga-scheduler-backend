import yauzl from "yauzl";
import { isZipEntryDirectory, validateZipEntryPolicy } from "./zipArtifactPolicy.js";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 200;
const MAX_MANIFEST_BYTES = 64 * 1024;

export async function validateZipBuffer(buffer, { entrypoint, runtime, wrapperVersion } = {}) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded artifact is empty");
  }

  if (buffer.length > MAX_ZIP_BYTES) {
    throw new Error(`Zip exceeds max size of ${MAX_ZIP_BYTES} bytes`);
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) {
        reject(new Error(`Invalid zip file: ${openErr.message}`));
        return;
      }

      let fileCount = 0;
      let uncompressedBytes = 0;
      let hasEntrypoint = false;
      let hasManifest = false;
      let manifest;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error);
      };

      zipfile.readEntry();

      zipfile.on("entry", (entry) => {
        if (settled) return;

        let name;
        try {
          name = validateZipEntryPolicy(entry.fileName, entry);
        } catch (error) {
          fail(error);
          return;
        }

        const isDirectory = isZipEntryDirectory(entry.fileName);
        fileCount += isDirectory ? 0 : 1;
        uncompressedBytes += entry.uncompressedSize || 0;

        if (fileCount > MAX_FILE_COUNT) {
          fail(new Error(`Zip contains more than ${MAX_FILE_COUNT} files`));
          return;
        }

        if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
          fail(new Error(`Zip uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`));
          return;
        }

        if (name === entrypoint) {
          hasEntrypoint = true;
        }

        if (name === "manifest.json") {
          hasManifest = true;
        }

        if (isDirectory || name !== "manifest.json") {
          zipfile.readEntry();
          return;
        }

        if ((entry.uncompressedSize || 0) > MAX_MANIFEST_BYTES) {
          fail(new Error(`manifest.json exceeds ${MAX_MANIFEST_BYTES} bytes`));
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            fail(new Error(`Unable to read manifest.json: ${streamErr.message}`));
            return;
          }

          const chunks = [];
          let bytes = 0;

          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_MANIFEST_BYTES) {
              stream.destroy(new Error(`manifest.json exceeds ${MAX_MANIFEST_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });

          stream.on("error", (error) => {
            fail(new Error(`Unable to read manifest.json: ${error.message}`));
          });

          stream.on("end", () => {
            if (settled) return;

            try {
              manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (error) {
              fail(new Error(`manifest.json is invalid JSON: ${error.message}`));
              return;
            }

            zipfile.readEntry();
          });
        });
      });

      zipfile.on("end", () => {
        if (settled) return;

        if (!hasManifest) {
          reject(new Error("Zip must contain manifest.json"));
          return;
        }

        if (!hasEntrypoint) {
          reject(new Error(`Zip must contain entrypoint: ${entrypoint}`));
          return;
        }

        try {
          validateManifestContract(manifest, { entrypoint, runtime, wrapperVersion });
        } catch (error) {
          reject(error);
          return;
        }

        resolve({ fileCount, uncompressedBytes, manifest });
      });

      zipfile.on("error", (err) => {
        if (!settled) reject(new Error(`Zip validation failed: ${err.message}`));
      });
    });
  });
}

function validateManifestContract(manifest, { entrypoint, runtime, wrapperVersion }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest.json must contain a JSON object");
  }

  assertManifestField(manifest, "entrypoint", entrypoint);

  if (runtime !== undefined) {
    assertManifestField(manifest, "runtime", runtime);
  }

  if (wrapperVersion !== undefined) {
    assertManifestField(manifest, "wrapperVersion", wrapperVersion);
  }
}

function assertManifestField(manifest, field, expected) {
  if (manifest[field] !== expected) {
    throw new Error(`manifest.json ${field} must match metadata ${field}: expected ${expected}`);
  }
}
