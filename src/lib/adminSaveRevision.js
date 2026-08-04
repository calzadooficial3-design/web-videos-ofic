function normalizeRevision(value, fallback = 0) {
  const revision = Number(value)
  if (Number.isSafeInteger(revision) && revision >= 0) return revision

  const fallbackRevision = Number(fallback)
  return Number.isSafeInteger(fallbackRevision) && fallbackRevision >= 0
    ? fallbackRevision
    : 0
}

/**
 * Mantiene la revisión que Supabase confirmó, separada de los snapshots que
 * React pudo capturar mientras había otro guardado en curso.
 */
export function createAdminSaveRevisionTracker(initialRevision = 0) {
  let confirmedRevision = normalizeRevision(initialRevision)

  return {
    current() {
      return confirmedRevision
    },
    reset(revision = 0) {
      confirmedRevision = normalizeRevision(revision)
      return confirmedRevision
    },
    confirm(revision) {
      confirmedRevision = Math.max(
        confirmedRevision,
        normalizeRevision(revision, confirmedRevision),
      )
      return confirmedRevision
    },
    rebase(snapshot) {
      return {
        ...snapshot,
        revision: confirmedRevision,
      }
    },
  }
}
