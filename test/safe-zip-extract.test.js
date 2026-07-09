import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { safeZipExtract } from "../src/utils/safeZipExtract.js";

const execFileAsync = promisify(execFile);

async function createZip(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iga-zip-src-"));
  const zipPath = path.join(os.tmpdir(), `iga-test-${Date.now()}-${Math.random()}.zip`);

  try {
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, entry.content ?? "");
    }

    await execFileAsync("zip", ["-qry", zipPath, "."], { cwd: dir });
    return await fs.readFile(zipPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(zipPath, { force: true });
  }
}

describe("safeZipExtract", () => {
  it("extracts normal zip into temp directory", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "console.log('ok');" }
    ]);

    const result = await safeZipExtract(buffer, { entrypoint: "index.js" });

    try {
      await expect(fs.readFile(result.entrypointPath, "utf8")).resolves.toBe("console.log('ok');");
      expect(result.fileCount).toBe(2);
      expect(result.uncompressedBytes).toBeGreaterThan(0);
    } finally {
      await result.cleanup();
    }

    await expect(fs.stat(result.extractDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe entrypoint path", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "console.log('ok');" }
    ]);

    const unsafeEntrypoint = ["..", "index.js"].join("/");

    await expect(safeZipExtract(buffer, { entrypoint: unsafeEntrypoint })).rejects.toThrow(
        "unsafe entrypoint path"
    );
  });

  it("rejects absolute entrypoint path", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "console.log('ok');" }
    ]);

    const unsafeEntrypoint = path.posix.join("/", "tmp", "index.js");

    await expect(safeZipExtract(buffer, { entrypoint: unsafeEntrypoint })).rejects.toThrow(
        "unsafe entrypoint path"
    );
  });

  it("rejects missing entrypoint after extraction", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "other.js", content: "console.log('no');" }
    ]);

    await expect(safeZipExtract(buffer, { entrypoint: "index.js" })).rejects.toThrow(
        "entrypoint not found after extraction: index.js"
    );
  });

  it("enforces file count limit", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "console.log('ok');" }
    ]);

    await expect(safeZipExtract(buffer, {
      entrypoint: "index.js",
      maxFileCount: 1
    })).rejects.toThrow("zip contains more than 1 files");
  });

  it("enforces uncompressed byte limit", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: "{}" },
      { name: "index.js", content: "console.log('ok');" }
    ]);

    await expect(safeZipExtract(buffer, {
      entrypoint: "index.js",
      maxUncompressedBytes: 1
    })).rejects.toThrow("zip uncompressed size exceeds 1 bytes");
  });
});
