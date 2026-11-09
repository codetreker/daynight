package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (tx *DAO) ListSessionUploadsForSettlement(ctx context.Context, id string, now time.Time) ([]store.SessionUploadRecord, error) {
	rows, err := tx.tx.Query(ctx, `SELECT upload_id::text FROM session_image_uploads upload WHERE session_id=$1 AND
  (receipt->>'state' IN ('receiving','verifying','complete') AND expires_at<=$2
   OR receipt->>'state' IN ('released','expired','failed') AND (NOT storage_released OR EXISTS(SELECT 1 FROM session_resources resource WHERE resource.session_id=upload.session_id AND resource.blob_id=upload.blob_id)))
 ORDER BY upload_id`, id, now)
	if err != nil {
		return nil, mediaQueryError("list upload settlement", err)
	}
	var ids []string
	for rows.Next() {
		var upload string
		if err = rows.Scan(&upload); err != nil {
			rows.Close()
			return nil, mediaQueryError("read upload settlement identity", err)
		}
		ids = append(ids, upload)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, mediaQueryError("list upload settlement", err)
	}
	out := make([]store.SessionUploadRecord, 0, len(ids))
	for _, upload := range ids {
		row, e := tx.SessionUpload(ctx, id, upload)
		if e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	return out, nil
}
func (tx *DAO) MarkSessionResourceReclaim(ctx context.Context, id, resource string) (bool, error) {
	tag, err := tx.tx.Exec(ctx, `UPDATE session_resources resource SET gc_pending=true WHERE session_id=$1 AND resource_id=$2 AND NOT EXISTS(SELECT 1 FROM session_resource_references ref WHERE ref.session_id=resource.session_id AND ref.resource_id=resource.resource_id)`, id, resource)
	if err != nil {
		return false, mediaQueryError("claim resource reclamation", err)
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	var retained bool
	err = tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resources WHERE session_id=$1 AND resource_id=$2)`, id, resource).Scan(&retained)
	return !retained, mediaQueryError("read resource reclamation", err)
}
func (tx *DAO) DeleteReclaimedSessionResource(ctx context.Context, id, resource string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM session_resources resource WHERE session_id=$1 AND resource_id=$2 AND gc_pending AND NOT EXISTS(SELECT 1 FROM session_resource_references ref WHERE ref.session_id=resource.session_id AND ref.resource_id=resource.resource_id) AND NOT EXISTS(SELECT 1 FROM session_resource_leases lease WHERE lease.session_id=resource.session_id AND (lease.resource_id IS NULL OR lease.resource_id=resource.resource_id))`, id, resource)
	if err != nil {
		return mediaQueryError("finish resource reclamation", err)
	}
	var retained bool
	err = tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resources WHERE session_id=$1 AND resource_id=$2)`, id, resource).Scan(&retained)
	if err != nil {
		return mediaQueryError("confirm resource reclamation", err)
	}
	if retained {
		return &model.Fault{Code: "resource_busy", Message: "Original resource ownership has not finished."}
	}
	return nil
}
