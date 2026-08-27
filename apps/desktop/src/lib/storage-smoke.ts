export function createStorageSmokeMarker(runId: string): string {
  const normalizedRunId = runId.replace(/[^a-z0-9]/giu, "");
  if (!normalizedRunId) throw new Error("storage smoke run ID must contain letters or digits");
  return `storagesmokemarker${normalizedRunId}`;
}
