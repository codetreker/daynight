package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5/pgconn"
)

var _ store.SessionResourceDAO = (*DAO)(nil)
var _ store.SessionIntentDAO = (*DAO)(nil)

func (tx *DAO) SavedSessionResource(ctx context.Context, s, id string) (store.SessionResourceRecord, error) {
	r := store.SessionResourceRecord{SessionID: s}
	var raw []byte
	err := tx.tx.QueryRow(ctx, `SELECT descriptor,COALESCE(blob_id::text,''),COALESCE(blob_path,''),COALESCE(migration_id::text,''),gc_pending,content IS NOT NULL FROM session_resources WHERE session_id=$1 AND resource_id=$2`, s, id).Scan(&raw, &r.BlobID, &r.BlobPath, &r.MigrationID, &r.GCPending, &r.HasInlineContent)
	if err != nil {
		return r, mediaQueryError("read saved session resource", err)
	}
	if err = json.Unmarshal(raw, &r.Resource); err != nil {
		return r, mediaQueryError("decode saved resource", err)
	}
	return r, nil
}
func (tx *DAO) ListSessionResources(ctx context.Context, s string) ([]store.SessionResourceRecord, error) {
	rows, err := tx.tx.Query(ctx, `SELECT descriptor,COALESCE(blob_id::text,''),COALESCE(blob_path,''),COALESCE(migration_id::text,''),gc_pending,content IS NOT NULL FROM session_resources WHERE session_id=$1 ORDER BY resource_id`, s)
	if err != nil {
		return nil, mediaQueryError("list saved resources", err)
	}
	defer rows.Close()
	out := []store.SessionResourceRecord{}
	for rows.Next() {
		r := store.SessionResourceRecord{SessionID: s}
		var raw []byte
		if err = rows.Scan(&raw, &r.BlobID, &r.BlobPath, &r.MigrationID, &r.GCPending, &r.HasInlineContent); err != nil {
			return nil, mediaQueryError("scan saved resource", err)
		}
		if err = json.Unmarshal(raw, &r.Resource); err != nil {
			return nil, mediaQueryError("decode saved resource", err)
		}
		out = append(out, r)
	}
	return out, mediaQueryError("list saved resources", rows.Err())
}
func (tx *DAO) InsertSessionResource(ctx context.Context, r store.SessionResourceRecord) error {
	raw, err := json.Marshal(r.Resource)
	if err != nil {
		return err
	}
	var blob, path, migration any
	if r.BlobID != "" {
		blob, path = r.BlobID, r.BlobPath
	}
	if r.MigrationID != "" {
		migration = r.MigrationID
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path,migration_id) VALUES($1,$2,$3,$4,$5,$6)`, r.SessionID, r.Resource.ResourceID, raw, blob, path, migration)
	return mediaQueryError("insert saved resource", err)
}
func (tx *DAO) AddSessionResourceReference(ctx context.Context, r store.SessionResourceReference) error {
	tag, err := tx.tx.Exec(ctx, `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id)
 SELECT $1,$2,$3,$4 FROM session_resources WHERE session_id=$1 AND resource_id=$2 AND NOT gc_pending
 ON CONFLICT DO NOTHING`, r.SessionID, r.ResourceID, r.Kind, r.ReferenceID)
	if err != nil {
		return mediaQueryError("pin session resource", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var retained bool
	err = tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references ref JOIN session_resources resource USING(session_id,resource_id) WHERE ref.session_id=$1 AND ref.resource_id=$2 AND ref.kind=$3 AND ref.reference_id=$4 AND NOT resource.gc_pending)`, r.SessionID, r.ResourceID, r.Kind, r.ReferenceID).Scan(&retained)
	if err != nil {
		return mediaQueryError("read existing resource pin", err)
	}
	if !retained {
		return &model.Fault{Code: "resource_conflict", Message: "The original resource is being reclaimed or no longer exists."}
	}
	return nil
}
func (tx *DAO) RemoveSessionResourceReference(ctx context.Context, r store.SessionResourceReference) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind=$3 AND reference_id=$4`, r.SessionID, r.ResourceID, r.Kind, r.ReferenceID)
	return mediaQueryError("unpin session resource", err)
}
func (tx *DAO) SessionResourceReferenceCount(ctx context.Context, s, id string) (int, error) {
	var n int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_resource_references WHERE session_id=$1 AND resource_id=$2`, s, id).Scan(&n)
	return n, mediaQueryError("count resource references", err)
}
func (tx *DAO) SessionResourceReferenceExists(ctx context.Context, r store.SessionResourceReference) (bool, error) {
	var found bool
	e := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind=$3 AND reference_id=$4)`, r.SessionID, r.ResourceID, r.Kind, r.ReferenceID).Scan(&found)
	return found, mediaQueryError("read resource reference", e)
}
func (tx *DAO) SessionResourceUsage(ctx context.Context, s string) (store.SessionResourceUsage, error) {
	var r store.SessionResourceUsage
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_resource_state(session_id) VALUES($1) ON CONFLICT DO NOTHING`, s)
	if err != nil {
		return r, mediaQueryError("initialize resource state", err)
	}
	err = tx.tx.QueryRow(ctx, `SELECT delete_epoch,deleting,EXISTS(SELECT 1 FROM session_archive_bundles WHERE session_id=$1 AND phase IN ('sealed','committed','verified')),(SELECT COALESCE(sum((descriptor->>'byteLength')::bigint),0) FROM session_resources WHERE session_id=$1 AND descriptor->>'status'='available'),(SELECT count(*) FROM session_resources WHERE session_id=$1 AND descriptor->>'status'='available') FROM session_resource_state WHERE session_id=$1 FOR UPDATE`, s).Scan(&r.DeleteEpoch, &r.Deleting, &r.Frozen, &r.Bytes, &r.Resources)
	return r, mediaQueryError("read resource state", err)
}
func (tx *DAO) SessionUpload(ctx context.Context, s, id string) (store.SessionUploadRecord, error) {
	r := store.SessionUploadRecord{SessionID: s}
	var spec, receipt []byte
	err := tx.tx.QueryRow(ctx, `SELECT actor_id::text,blob_id::text,spec,receipt,expires_at,storage_released FROM session_image_uploads WHERE session_id=$1 AND upload_id=$2`, s, id).Scan(&r.ActorID, &r.BlobID, &spec, &receipt, &r.ExpiresAt, &r.StorageReleased)
	if err != nil {
		return r, mediaQueryError("read image upload", err)
	}
	if err = json.Unmarshal(spec, &r.Spec); err == nil {
		err = json.Unmarshal(receipt, &r.Receipt)
	}
	return r, mediaQueryError("decode image upload", err)
}
func (tx *DAO) SessionImageUploadExists(ctx context.Context, s, image string) (bool, error) {
	var found bool
	e := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_image_uploads WHERE session_id=$1 AND image_id=$2)`, s, image).Scan(&found)
	return found, mediaQueryError("read image upload identity", e)
}
func (tx *DAO) SaveSessionUpload(ctx context.Context, r store.SessionUploadRecord) error {
	spec, err := json.Marshal(r.Spec)
	if err != nil {
		return err
	}
	receipt, err := json.Marshal(r.Receipt)
	if err != nil {
		return err
	}
	tag, err := tx.tx.Exec(ctx, `INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at,storage_released) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(session_id,upload_id) DO UPDATE SET receipt=EXCLUDED.receipt,storage_released=EXCLUDED.storage_released WHERE session_image_uploads.spec=EXCLUDED.spec AND session_image_uploads.actor_id=EXCLUDED.actor_id AND session_image_uploads.blob_id=EXCLUDED.blob_id AND session_image_uploads.expires_at=EXCLUDED.expires_at`, r.SessionID, r.Spec.UploadID, r.ActorID, r.Spec.ImageID, r.BlobID, spec, receipt, r.ExpiresAt, r.StorageReleased)
	if err != nil {
		return mediaQueryError("save image upload", err)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_conflict", Message: "Image upload identity already has different content."}
	}
	return nil
}
func (tx *DAO) SessionUploadChunks(ctx context.Context, s, id string) ([]store.SessionUploadChunk, error) {
	rows, err := tx.tx.Query(ctx, `SELECT chunk_offset,byte_length,sha256,blob_path FROM session_image_chunks WHERE session_id=$1 AND upload_id=$2 ORDER BY chunk_offset`, s, id)
	if err != nil {
		return nil, mediaQueryError("read image chunks", err)
	}
	defer rows.Close()
	out := []store.SessionUploadChunk{}
	for rows.Next() {
		r := store.SessionUploadChunk{SessionID: s, UploadID: id}
		if err = rows.Scan(&r.Offset, &r.ByteLength, &r.SHA256, &r.Path); err != nil {
			return nil, mediaQueryError("read image chunk", err)
		}
		out = append(out, r)
	}
	return out, mediaQueryError("read image chunks", rows.Err())
}
func (tx *DAO) InsertSessionUploadChunk(ctx context.Context, r store.SessionUploadChunk) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$2,$3,$4,$5,$6)`, r.SessionID, r.UploadID, r.Offset, r.ByteLength, r.SHA256, r.Path)
	return mediaQueryError("commit image chunk", err)
}
func (tx *DAO) SessionCapture(ctx context.Context, s, id string) (store.SessionCaptureRecord, error) {
	r := store.SessionCaptureRecord{SessionID: s}
	var request, receipt, validated []byte
	err := tx.tx.QueryRow(ctx, `SELECT request,receipt,validated FROM session_image_captures WHERE session_id=$1 AND capture_id=$2`, s, id).Scan(&request, &receipt, &validated)
	if err != nil {
		return r, mediaQueryError("read image capture", err)
	}
	if err = json.Unmarshal(request, &r.Request); err == nil {
		err = json.Unmarshal(receipt, &r.Receipt)
	}
	if err == nil && len(validated) > 0 {
		err = json.Unmarshal(validated, &r.Validated)
	}
	return r, mediaQueryError("decode image capture", err)
}
func (tx *DAO) SessionCaptureByImage(ctx context.Context, s, image string) (store.SessionCaptureRecord, error) {
	var id string
	e := tx.tx.QueryRow(ctx, `SELECT capture_id::text FROM session_image_captures WHERE session_id=$1 AND image_id=$2`, s, image).Scan(&id)
	if e != nil {
		return store.SessionCaptureRecord{}, mediaQueryError("read original image occurrence", e)
	}
	return tx.SessionCapture(ctx, s, id)
}
func (tx *DAO) SaveSessionCapture(ctx context.Context, r store.SessionCaptureRecord) error {
	request, e := json.Marshal(r.Request)
	if e != nil {
		return e
	}
	receipt, e := json.Marshal(r.Receipt)
	if e != nil {
		return e
	}
	var validated any
	if r.Validated != nil {
		validated, _ = json.Marshal(r.Validated)
	}
	var tag pgconn.CommandTag
	if r.Expected == nil {
		tag, e = tx.tx.Exec(ctx, `INSERT INTO session_image_captures(session_id,capture_id,image_id,request,receipt,validated) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, r.SessionID, r.Request.CaptureID, r.Request.Occurrence.ImageID, request, receipt, validated)
	} else {
		expectedReceipt, err := json.Marshal(r.Expected.Receipt)
		if err != nil {
			return err
		}
		var expectedValidated any
		if r.Expected.Validated != nil {
			expectedValidated, _ = json.Marshal(r.Expected.Validated)
		}
		tag, e = tx.tx.Exec(ctx, `UPDATE session_image_captures SET receipt=$4,validated=$5
WHERE session_id=$1 AND capture_id=$2 AND request=$3 AND receipt=$6 AND validated IS NOT DISTINCT FROM $7::jsonb`, r.SessionID, r.Request.CaptureID, request, receipt, validated, expectedReceipt, expectedValidated)
	}
	if e != nil {
		return mediaQueryError("save image capture", e)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_conflict", Message: "Image capture identity already has different content."}
	}
	return nil
}
func (tx *DAO) AcquireSessionResourceLease(ctx context.Context, r store.SessionResourceLease) error {
	// A transaction advisory lock serializes admission counters across instances;
	// it never spans decoder, storage, network, or reader work.
	if _, err := tx.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(735842191)`); err != nil {
		return mediaQueryError("lock media admission", err)
	}
	var n, account, session int
	var epoch int64
	var deleting bool
	err := tx.tx.QueryRow(ctx, `SELECT delete_epoch,deleting,(SELECT count(*) FROM session_resource_leases),(SELECT count(*) FROM session_resource_leases WHERE owner_id=$2),(SELECT count(*) FROM session_resource_leases WHERE session_id=$1) FROM session_resource_state WHERE session_id=$1`, r.SessionID, r.OwnerID).Scan(&epoch, &deleting, &n, &account, &session)
	if err != nil {
		return mediaQueryError("check media admission", err)
	}
	if deleting || epoch != r.DeleteEpoch {
		return &model.Fault{Code: "resource_conflict", Message: "Session resource deletion has begun."}
	}
	if n >= r.Admission.Global || account >= r.Admission.Owner || session >= r.Admission.Session {
		return &model.Fault{Code: "rate_limited", Message: "Media transfer capacity is unavailable."}
	}
	var resource any
	var reclaiming bool
	if r.ResourceID != "" {
		if err = tx.tx.QueryRow(ctx, `SELECT gc_pending FROM session_resources WHERE session_id=$1 AND resource_id=$2`, r.SessionID, r.ResourceID).Scan(&reclaiming); err != nil {
			return mediaQueryError("check resource reclamation", err)
		}
		resource = r.ResourceID
	} else if err = tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resources WHERE session_id=$1 AND gc_pending)`, r.SessionID).Scan(&reclaiming); err != nil {
		return mediaQueryError("check session resource reclamation", err)
	}
	if reclaiming {
		return &model.Fault{Code: "resource_conflict", Message: "The original resource is being reclaimed."}
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,resource_id,delete_epoch) VALUES($1,$2,$3,$4,$5,$6)`, r.SessionID, r.ID, r.OwnerID, r.Kind, resource, r.DeleteEpoch)
	return mediaQueryError("acquire resource lease", err)
}
func (tx *DAO) ReleaseSessionResourceLease(ctx context.Context, s, id string) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM session_resource_leases WHERE session_id=$1 AND lease_id=$2`, s, id)
	return mediaQueryError("release resource lease", err)
}
func (tx *DAO) BeginSessionResourceDeletion(ctx context.Context, s string) (int64, error) {
	var n int64
	err := tx.tx.QueryRow(ctx, `UPDATE session_resource_state SET delete_epoch=delete_epoch+CASE WHEN deleting THEN 0 ELSE 1 END,deleting=true WHERE session_id=$1 RETURNING delete_epoch`, s).Scan(&n)
	return n, mediaQueryError("close resource admission", err)
}
func (tx *DAO) SessionResourceLeaseCount(ctx context.Context, s string) (int, error) {
	var n int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_resource_leases WHERE session_id=$1`, s).Scan(&n)
	return n, mediaQueryError("count resource leases", err)
}
func (tx *DAO) SessionOperationIntent(ctx context.Context, s, id string) ([]byte, error) {
	var b []byte
	err := tx.tx.QueryRow(ctx, `SELECT canonical_bytes FROM session_operation_intents WHERE session_id=$1 AND operation_id=$2`, s, id).Scan(&b)
	return b, mediaQueryError("read operation intent", err)
}
func (tx *DAO) InsertSessionOperationIntent(ctx context.Context, s, id string, b []byte) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_operation_intents(session_id,operation_id,canonical_bytes) VALUES($1,$2,$3)`, s, id, b)
	return mediaQueryError("persist operation intent", err)
}

func mediaQueryError(phase string, err error) error {
	if err == nil {
		return nil
	}
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		return &model.Fault{Code: "resource_conflict", Message: "The resource identity already belongs to different content."}
	}
	return pg.QueryError(phase, err)
}

func (tx *DAO) UnsettledSessionResourceWrites(ctx context.Context, s string) (int, error) {
	var n int
	err := tx.tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_image_uploads WHERE session_id=$1 AND (receipt->>'state' IN ('receiving','verifying') OR receipt->>'state' IN ('failed','expired','released') AND (NOT storage_released OR EXISTS(SELECT 1 FROM session_resources resources WHERE resources.session_id=session_image_uploads.session_id AND resources.blob_id=session_image_uploads.blob_id))))+(SELECT count(*) FROM session_image_captures WHERE session_id=$1 AND receipt->>'state' IN ('reserved','copying'))+(SELECT count(*) FROM session_operations operations
WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching','unknown')
AND (command->>'kind' IN ('send_message','interaction_response','execute_command','cancel')
 OR EXISTS(SELECT 1 FROM session_resource_references refs
   WHERE refs.session_id=operations.session_id AND refs.reference_id=operations.operation_id::text
     AND refs.kind IN ('operation','native_resume'))))+(SELECT count(*) FROM session_media_requests media WHERE session_id=$1 AND NOT complete AND action IN ('write','complete') AND EXISTS(SELECT 1 FROM session_image_uploads uploads WHERE uploads.session_id=media.session_id AND uploads.upload_id=(media.body->>'uploadId')::uuid AND uploads.receipt->>'state' NOT IN ('released','expired','failed')))`, s).Scan(&n)
	return n, mediaQueryError("count unsettled resource writes", err)
}

func (tx *DAO) ListSessionResourceLeases(ctx context.Context, s string) ([]store.SessionResourceLease, error) {
	rows, err := tx.tx.Query(ctx, `SELECT lease_id::text,owner_id::text,kind,COALESCE(resource_id::text,''),delete_epoch FROM session_resource_leases WHERE session_id=$1 ORDER BY lease_id`, s)
	if err != nil {
		return nil, mediaQueryError("list resource leases", err)
	}
	defer rows.Close()
	out := []store.SessionResourceLease{}
	for rows.Next() {
		r := store.SessionResourceLease{SessionID: s}
		if err = rows.Scan(&r.ID, &r.OwnerID, &r.Kind, &r.ResourceID, &r.DeleteEpoch); err != nil {
			return nil, mediaQueryError("read resource lease", err)
		}
		out = append(out, r)
	}
	return out, mediaQueryError("list resource leases", rows.Err())
}

func (tx *DAO) SessionMediaRequest(ctx context.Context, s, id string) (store.SessionMediaRequest, error) {
	r := store.SessionMediaRequest{SessionID: s, RequestID: id}
	var fence, errorBody []byte
	err := tx.tx.QueryRow(ctx, `SELECT action,fence,body,result,error,complete FROM session_media_requests WHERE session_id=$1 AND request_id=$2`, s, id).Scan(&r.Action, &fence, &r.Body, &r.Result, &errorBody, &r.Complete)
	if err != nil {
		return r, mediaQueryError("read media request", err)
	}
	if err = json.Unmarshal(fence, &r.Fence); err != nil {
		return r, err
	}
	if len(errorBody) > 0 {
		err = json.Unmarshal(errorBody, &r.Error)
	}
	return r, err
}
func (tx *DAO) SaveSessionMediaRequest(ctx context.Context, r store.SessionMediaRequest) error {
	fence, e := json.Marshal(r.Fence)
	if e != nil {
		return e
	}
	var result, errorBody any
	if r.Result != nil {
		result = r.Result
	}
	if r.Error != nil {
		errorBody, e = json.Marshal(r.Error)
		if e != nil {
			return e
		}
	}
	if r.Expected != nil {
		observed := r.Expected
		expectedFence, err := json.Marshal(observed.Fence)
		if err != nil {
			return err
		}
		var expectedResult, expectedError any
		if observed.Result != nil {
			expectedResult = observed.Result
		}
		if observed.Error != nil {
			expectedError, err = json.Marshal(observed.Error)
			if err != nil {
				return err
			}
		}
		tag, err := tx.tx.Exec(ctx, `UPDATE session_media_requests SET fence=$4,body=$5,result=$6,error=$7,complete=$8 WHERE session_id=$1 AND request_id=$2 AND action=$3 AND fence=$9 AND body=$10 AND result IS NOT DISTINCT FROM $11::jsonb AND error IS NOT DISTINCT FROM $12::jsonb AND complete=$13`, r.SessionID, r.RequestID, r.Action, fence, r.Body, result, errorBody, r.Complete, expectedFence, observed.Body, expectedResult, expectedError, observed.Complete)
		if err != nil {
			return mediaQueryError("rewrite media request", err)
		}
		if tag.RowsAffected() != 1 {
			return &model.Fault{Code: "resource_conflict", Message: "The observed media request changed before its representation rewrite."}
		}
		return nil
	}
	tag, e := tx.tx.Exec(ctx, `INSERT INTO session_media_requests(session_id,request_id,action,fence,body,result,error,complete) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id,request_id) DO UPDATE SET fence=EXCLUDED.fence,result=EXCLUDED.result,error=EXCLUDED.error,complete=EXCLUDED.complete WHERE session_media_requests.action=EXCLUDED.action AND (session_media_requests.fence-'connectionEpoch')=(EXCLUDED.fence-'connectionEpoch') AND session_media_requests.body=EXCLUDED.body AND (NOT session_media_requests.complete OR session_media_requests.result IS NOT DISTINCT FROM EXCLUDED.result AND session_media_requests.error IS NOT DISTINCT FROM EXCLUDED.error)`, r.SessionID, r.RequestID, r.Action, fence, r.Body, result, errorBody, r.Complete)
	if e != nil {
		return mediaQueryError("save media request", e)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_conflict", Message: "Media request identity already has different content."}
	}
	return nil
}
func (tx *DAO) PendingSessionMediaRequests(ctx context.Context, current sp.Fence) ([]store.SessionMediaRequest, error) {
	fence, e := json.Marshal(current)
	if e != nil {
		return nil, e
	}
	rows, e := tx.tx.Query(ctx, `SELECT request_id::text FROM session_media_requests WHERE session_id=$1 AND (fence-'connectionEpoch')=$2::jsonb AND NOT complete AND NOT(action IN ('write','complete') AND EXISTS(SELECT 1 FROM session_image_uploads uploads WHERE uploads.session_id=session_media_requests.session_id AND uploads.upload_id=(session_media_requests.body->>'uploadId')::uuid AND uploads.receipt->>'state' IN ('released','expired','failed'))) ORDER BY request_id LIMIT 2`, current.SessionID, fence)
	if e != nil {
		return nil, mediaQueryError("list pending media", e)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := []store.SessionMediaRequest{}
	for _, id := range ids {
		r, e := tx.SessionMediaRequest(ctx, current.SessionID, id)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, nil
}

// SessionUploadMediaRequests selects exact identities; representation policy
// and safe settlement remain with the Session core.
func (tx *DAO) SessionUploadMediaRequests(ctx context.Context, s, uploadID, resourceID string) ([]store.SessionMediaRequest, error) {
	rows, err := tx.tx.Query(ctx, `SELECT request_id::text FROM session_media_requests WHERE session_id=$1 AND (body->>'uploadId'=$2 OR body->>'attemptId'=$2 OR body->>'preparationId'=$2 OR body->>'resourceId'=$3) ORDER BY request_id`, s, uploadID, resourceID)
	if err != nil {
		return nil, mediaQueryError("list upload media", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]store.SessionMediaRequest, 0, len(ids))
	for _, id := range ids {
		row, err := tx.SessionMediaRequest(ctx, s, id)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}
