export const PORTABLE_CATALOG_PROVENANCE_STRING_KEYS = [
  "sourceRef",
  "originHash",
  "catalogId",
  "catalogKey",
  "catalogKind",
  "catalogCategory",
  "catalogPath",
  "packageName",
  "packageVersion",
  "originVersion",
  "installedHash",
  "userModifiedAt",
  "updateHoldReason",
  "auditVerdict",
  "auditScannedAt",
  "auditScanVersion",
] as const;

function asCatalogString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readCatalogStringList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => asCatalogString(entry)).filter((entry): entry is string => Boolean(entry));
  return entries.length === value.length ? entries : null;
}
