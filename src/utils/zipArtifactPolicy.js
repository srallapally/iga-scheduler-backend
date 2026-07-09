import path from "path";

const DENIED_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "secrets.json",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

const DENIED_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gcp",
  ".azure"
]);

export function validateZipEntryPolicy(entryName, entry = {}) {
  const normalizedName = normalizeZipRelativePath(entryName, "zip entry");

  if (isDeniedPath(normalizedName)) {
    throw new Error(`Denied file in zip: ${entryName}`);
  }

  if (isZipEntrySymlink(entry)) {
    throw new Error(`Symlinks are not allowed: ${entryName}`);
  }

  return normalizedName;
}

export function normalizeZipRelativePath(value, label = "zip entry") {
  if (!value || typeof value !== "string" || value.trim() === "") {
    throw new Error(`unsafe ${label} path: ${value}`);
  }

  if (value.includes("\\")) {
    throw new Error(`unsafe ${label} path: ${value}`);
  }

  if (path.posix.isAbsolute(value)) {
    throw new Error(`unsafe ${label} path: ${value}`);
  }

  const normalized = path.posix.normalize(value);

  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe ${label} path: ${value}`);
  }

  return normalized;
}

export function isZipEntryDirectory(entryName) {
  return entryName.endsWith("/");
}

export function isZipEntrySymlink(entry = {}) {
  const externalFileAttributes = entry.externalFileAttributes || 0;
  const unixMode = (externalFileAttributes >> 16) & 0o170000;
  const dosDirectoryFlag = externalFileAttributes & 0x10;
  const normalizedName = entry.fileName || "";

  if (unixMode === 0o120000) {
    return true;
  }

  if (unixMode === 0 && !dosDirectoryFlag && normalizedName.endsWith(".lnk")) {
    return true;
  }

  return false;
}

function isDeniedPath(name) {
  const parts = name.split("/").filter(Boolean);
  return parts.some((part) => DENIED_FILENAMES.has(part) || DENIED_DIRECTORY_NAMES.has(part));
}
