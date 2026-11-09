package session

import "context"

// SessionResourceReadableBy is evaluated inside the authorized Session lock.
// Lifetime pins alone never publish a private original to other project readers.
func (tx *DAO) SessionResourceReadableBy(ctx context.Context, session, resource, actor string) (bool, error) {
	var visible bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM session_resource_references ref
 WHERE ref.session_id=$1 AND ref.resource_id=$2 AND (
  ref.kind='message'
  OR (ref.kind='upload' AND EXISTS (
   SELECT 1 FROM session_image_uploads upload
   WHERE upload.session_id=ref.session_id AND upload.upload_id::text=ref.reference_id
    AND upload.actor_id=$3 AND upload.receipt->>'state'='complete'
    AND upload.receipt->'resource'->>'resourceId'=$2::text
  ))
  OR (ref.kind='archive' AND EXISTS (
   SELECT 1 FROM session_archives archive WHERE archive.session_id=ref.session_id
    AND archive.state='ready' AND archive.schema_version=3 AND (
     EXISTS (SELECT 1 FROM session_archive_bundles bundle
      WHERE bundle.session_id=ref.session_id AND bundle.prepare_id::text=ref.reference_id
       AND bundle.phase IN ('committed','verified') AND bundle.manifest_hash=archive.sha256)
     OR EXISTS (SELECT 1 FROM session_archive_migrations migration
      WHERE migration.session_id=ref.session_id AND migration.migration_id::text=ref.reference_id
       AND migration.phase IN ('committed','verified') AND migration.target_hash=archive.sha256)
    )
  ))
 ))`, session, resource, actor).Scan(&visible)
	return visible, mediaQueryError("authorize saved resource read", err)
}
