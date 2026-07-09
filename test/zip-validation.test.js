import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { validateZipBuffer } from "../src/utils/zipValidation.js";

const execFileAsync = promisify(execFile);

async function createZip(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iga-zip-validation-src-"));
  const zipPath = path.join(os.tmpdir(), `iga-zip-validation-${Date.now()}-${Math.random()}.zip`);

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

function manifest(overrides = {}) {
  return JSON.stringify({ runtime: "javascript", wrapperVersion: "1.0.0", entrypoint: "index.js", ...overrides });
}

async function artifactBuffer(manifestOverrides = {}) {
  return createZip([
    { name: "manifest.json", content: manifest(manifestOverrides) },
    { name: "index.js", content: "console.log('ok');" },
    { name: "evil.js", content: "console.log('evil');" }
  ]);
}

describe("validateZipBuffer", () => {
  it("parses manifest and returns it with zip info", async () => {
    const result = await validateZipBuffer(await artifactBuffer(), { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" });
    expect(result).toEqual(expect.objectContaining({ fileCount: 3, manifest: { runtime: "javascript", wrapperVersion: "1.0.0", entrypoint: "index.js" } }));
    expect(result.uncompressedBytes).toBeGreaterThan(0);
  });

  it("rejects manifest entrypoint mismatch", async () => {
    await expect(validateZipBuffer(await artifactBuffer({ entrypoint: "evil.js" }), { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("manifest.json entrypoint must match metadata entrypoint: expected index.js");
  });

  it("rejects manifest runtime mismatch", async () => {
    await expect(validateZipBuffer(await artifactBuffer({ runtime: "python" }), { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("manifest.json runtime must match metadata runtime: expected javascript");
  });

  it("rejects manifest wrapperVersion mismatch", async () => {
    await expect(validateZipBuffer(await artifactBuffer({ wrapperVersion: "2.0.0" }), { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("manifest.json wrapperVersion must match metadata wrapperVersion: expected 1.0.0");
  });

  it("rejects invalid manifest JSON", async () => {
    const buffer = await createZip([{ name: "manifest.json", content: "{bad-json" }, { name: "index.js", content: "console.log('ok');" }]);
    await expect(validateZipBuffer(buffer, { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("manifest.json is invalid JSON");
  });

  it("rejects denied files from the shared artifact policy", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: manifest() },
      { name: "index.js", content: "console.log('ok');" },
      { name: "nested/.env", content: "SECRET=value" }
    ]);

    await expect(validateZipBuffer(buffer, { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("Denied file in zip: nested/.env");
  });

  it("rejects denied directories from the shared artifact policy", async () => {
    const buffer = await createZip([
      { name: "manifest.json", content: manifest() },
      { name: "index.js", content: "console.log('ok');" },
      { name: ".ssh/config", content: "Host *" }
    ]);

    await expect(validateZipBuffer(buffer, { entrypoint: "index.js", runtime: "javascript", wrapperVersion: "1.0.0" })).rejects.toThrow("Denied file in zip: .ssh");
  });
});
