// Package webhook implements the webhook persistence contract in PostgreSQL.
package webhook

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const policyJSON = `{"attemptBytes":2048,"automaticAttemptSlots":10,"bindingLimit":6,"bucketActiveBytes":134217728,"bucketActiveRecords":32768,"bucketBytes":268435456,"bucketOperations":8192,"bucketQueue":4096,"bucketRecords":65536,"buckets":16,"configurationMetadataBytes":2048,"endpointLimit":20,"endpointQueue":256,"fanoutLimit":256,"maxDeliveryRecords":63,"operationBytes":4096,"ownerActiveBytes":50331648,"ownerActiveRecords":24576,"ownerBytes":67108864,"ownerOperations":1024,"ownerQueue":1024,"ownerRecords":32768,"subscriptionLimit":50,"version":1}`
const policyDigest = "b2b44b7d8da24e4214d02ddf85fa8168e1bd0b502fe6d7fef84ebfdcc4d81c4d"

type DAO struct{ tx pgx.Tx }

func New(tx pgx.Tx) *DAO { return &DAO{tx: tx} }

var _ store.WebhookWriter = (*DAO)(nil)

const endpointColumns = `id::text,owner_kind,owner_id::text,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,origin,destination_ciphertext,active_key_id,created_at,updated_at`

func scanEndpoint(row pgx.Row) (model.Endpoint, error) {
	var e model.Endpoint
	err := row.Scan(&e.ID, &e.Owner.Kind, &e.Owner.ID, &e.Name, &e.Enabled, &e.DeletedAt, &e.ConfigVersion, &e.DestinationRevision, &e.DestinationKind, &e.AdapterVersion, &e.Origin, &e.DestinationCiphertext, &e.ActiveKeyID, &e.CreatedAt, &e.UpdatedAt)
	return e, err
}
func (d *DAO) Endpoint(ctx context.Context, o model.Owner, id string) (model.Endpoint, error) {
	e, err := scanEndpoint(d.tx.QueryRow(ctx, `SELECT `+endpointColumns+` FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2 AND id=$3`, o.Kind, o.ID, id))
	if err != nil {
		return model.Endpoint{}, pg.QueryError("read webhook endpoint", err)
	}
	return e, nil
}
func (d *DAO) LockEndpoint(ctx context.Context, o model.Owner, id string) (model.Endpoint, error) {
	e, err := scanEndpoint(d.tx.QueryRow(ctx, `SELECT `+endpointColumns+` FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, o.Kind, o.ID, id))
	if err != nil {
		return model.Endpoint{}, pg.QueryError("lock webhook endpoint", err)
	}
	return e, nil
}
func (d *DAO) Endpoints(ctx context.Context, o model.Owner) ([]model.Endpoint, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+endpointColumns+` FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`, o.Kind, o.ID)
	if err != nil {
		return nil, pg.QueryError("list webhook endpoints", err)
	}
	defer rows.Close()
	out := make([]model.Endpoint, 0)
	for rows.Next() {
		e, err := scanEndpoint(rows)
		if err != nil {
			return nil, pg.QueryError("list webhook endpoints", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list webhook endpoints", err)
	}
	return out, nil
}
func (d *DAO) SigningKeys(ctx context.Context, id string) ([]model.SigningKey, error) {
	rows, err := d.tx.Query(ctx, `SELECT endpoint_id::text,id,ciphertext,created_at,overlap_until,revoked_at FROM webhook_signing_keys WHERE endpoint_id=$1 ORDER BY created_at,id`, id)
	if err != nil {
		return nil, pg.QueryError("read webhook keys", err)
	}
	defer rows.Close()
	out := make([]model.SigningKey, 0)
	for rows.Next() {
		var k model.SigningKey
		if err := rows.Scan(&k.EndpointID, &k.ID, &k.Ciphertext, &k.CreatedAt, &k.OverlapUntil, &k.RevokedAt); err != nil {
			return nil, pg.QueryError("read webhook keys", err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook keys", err)
	}
	return out, nil
}
func (d *DAO) Operation(ctx context.Context, o model.Owner, id string) (model.Operation, error) {
	var r model.Operation
	r.Owner = o
	err := d.tx.QueryRow(ctx, `SELECT operation_id::text,actor_id::text,kind,target_id::text,issued_at,request_sha256,fingerprint,effect,config_version,destination_revision_after,active_key_id,overlap_until,recorded_at,expires_at FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, o.Kind, o.ID, id).Scan(&r.ID, &r.ActorID, &r.Kind, &r.TargetID, &r.IssuedAt, &r.RequestSHA256, &r.Fingerprint, &r.Effect, &r.ConfigVersion, &r.DestinationRevisionAfter, &r.ActiveKeyID, &r.OverlapUntil, &r.RecordedAt, &r.ExpiresAt)
	if err != nil {
		return model.Operation{}, pg.QueryError("read webhook operation", err)
	}
	return r, nil
}
func metadata(v any, max int) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > max {
		return store.ErrWebhookMetadataTooLarge
	}
	return nil
}
func (d *DAO) PutEndpoint(ctx context.Context, e model.Endpoint) error {
	copy := e
	copy.DestinationCiphertext = nil
	if err := metadata(copy, 2048); err != nil {
		return err
	}
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_endpoints (`+`id,owner_kind,owner_id,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,origin,destination_ciphertext,active_key_id,created_at,updated_at`+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,deleted_at=EXCLUDED.deleted_at,config_version=EXCLUDED.config_version,destination_revision=EXCLUDED.destination_revision,destination_kind=EXCLUDED.destination_kind,adapter_version=EXCLUDED.adapter_version,origin=EXCLUDED.origin,destination_ciphertext=EXCLUDED.destination_ciphertext,active_key_id=EXCLUDED.active_key_id,updated_at=EXCLUDED.updated_at WHERE webhook_endpoints.owner_kind=EXCLUDED.owner_kind AND webhook_endpoints.owner_id=EXCLUDED.owner_id`, e.ID, e.Owner.Kind, e.Owner.ID, e.Name, e.Enabled, e.DeletedAt, e.ConfigVersion, e.DestinationRevision, e.DestinationKind, e.AdapterVersion, e.Origin, e.DestinationCiphertext, e.ActiveKeyID, e.CreatedAt, e.UpdatedAt)
	if err != nil {
		return pg.QueryError("save webhook endpoint", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook endpoint owner mismatch")
	}
	return nil
}
func (d *DAO) PutSigningKey(ctx context.Context, k model.SigningKey) error {
	copy := k
	copy.Ciphertext = nil
	if err := metadata(copy, 2048); err != nil {
		return err
	}
	_, err := d.tx.Exec(ctx, `INSERT INTO webhook_signing_keys(endpoint_id,id,ciphertext,created_at,overlap_until,revoked_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(endpoint_id,id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,overlap_until=EXCLUDED.overlap_until,revoked_at=EXCLUDED.revoked_at`, k.EndpointID, k.ID, k.Ciphertext, k.CreatedAt, k.OverlapUntil, k.RevokedAt)
	if err != nil {
		return pg.QueryError("save webhook key", err)
	}
	return nil
}
func (d *DAO) DeleteSigningKeys(ctx context.Context, id string) error {
	_, err := d.tx.Exec(ctx, `DELETE FROM webhook_signing_keys WHERE endpoint_id=$1`, id)
	if err != nil {
		return pg.QueryError("delete webhook keys", err)
	}
	return nil
}
func (d *DAO) PutOperation(ctx context.Context, r model.Operation) error {
	if err := metadata(r, 4096); err != nil {
		return err
	}
	_, err := d.tx.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_id,kind,target_id,issued_at,request_sha256,fingerprint,effect,config_version,destination_revision_after,active_key_id,overlap_until,recorded_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, r.Owner.Kind, r.Owner.ID, r.ID, r.ActorID, r.Kind, r.TargetID, r.IssuedAt, r.RequestSHA256, r.Fingerprint, r.Effect, r.ConfigVersion, r.DestinationRevisionAfter, r.ActiveKeyID, r.OverlapUntil, r.RecordedAt, r.ExpiresAt)
	if err != nil {
		return pg.QueryError("save webhook operation", err)
	}
	return nil
}

// Bucket is stable across instances and unrelated to the advisory fence hash.
func Bucket(o model.Owner) int16 {
	id, err := uuid.Parse(o.ID)
	if err == nil {
		o.ID = id.String()
	}
	h := sha256.Sum256([]byte(o.Kind + "\x00" + o.ID))
	return int16(h[0] & 15)
}
func (d *DAO) Reserve(ctx context.Context, o model.Owner, endpoints, records, bytes, activeRecords, activeBytes int64, operation bool) error {
	var policyValid bool
	if err := d.tx.QueryRow(ctx, `SELECT parameters=$1::jsonb AND digest=$2 FROM webhook_policies WHERE version=1 FOR SHARE`, policyJSON, policyDigest).Scan(&policyValid); err != nil {
		return pg.QueryError("read webhook policy", err)
	}
	if !policyValid {
		return fmt.Errorf("webhook policy v1 mismatch")
	}
	bucket := Bucket(o)
	var bucketRecords, bucketBytes, bucketActiveRecords, bucketActiveBytes, bucketOps int64
	if err := d.tx.QueryRow(ctx, `SELECT records,bytes,active_records,active_bytes,operations FROM webhook_quota_buckets WHERE bucket=$1 FOR UPDATE`, bucket).Scan(&bucketRecords, &bucketBytes, &bucketActiveRecords, &bucketActiveBytes, &bucketOps); err != nil {
		return pg.QueryError("lock webhook bucket", err)
	}
	if _, err := d.tx.Exec(ctx, `INSERT INTO webhook_quota_owners(owner_kind,owner_id,bucket) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, o.Kind, o.ID, bucket); err != nil {
		return pg.QueryError("create webhook account", err)
	}
	var ep, rec, used, activeRec, activeUsed, ops int64
	var ownerBucket int16
	if err := d.tx.QueryRow(ctx, `SELECT bucket,endpoints,records,bytes,active_records,active_bytes,operations FROM webhook_quota_owners WHERE owner_kind=$1 AND owner_id=$2 FOR UPDATE`, o.Kind, o.ID).Scan(&ownerBucket, &ep, &rec, &used, &activeRec, &activeUsed, &ops); err != nil {
		return pg.QueryError("lock webhook account", err)
	}
	if ownerBucket != bucket {
		return fmt.Errorf("webhook account bucket mismatch")
	}
	op := int64(0)
	if operation {
		op = 1
	}
	if ops+op > 1024 || bucketOps+op > 8192 {
		return store.ErrWebhookOperationCapacity
	}
	if !within(ep, endpoints, 20) || !within(rec, records, 32768) || !within(used, bytes, 67108864) ||
		!within(bucketRecords, records, 65536) || !within(bucketBytes, bytes, 268435456) ||
		!within(activeRec, activeRecords, 24576) || !within(activeUsed, activeBytes, 50331648) ||
		!within(bucketActiveRecords, activeRecords, 32768) || !within(bucketActiveBytes, activeBytes, 134217728) {
		return store.ErrWebhookCapacity
	}
	if activeRec+activeRecords > rec+records || activeUsed+activeBytes > used+bytes ||
		bucketActiveRecords+activeRecords > bucketRecords+records || bucketActiveBytes+activeBytes > bucketBytes+bytes {
		return fmt.Errorf("invalid webhook active quota")
	}
	if _, err := d.tx.Exec(ctx, `UPDATE webhook_quota_buckets SET records=records+$2,bytes=bytes+$3,operations=operations+$4,active_records=active_records+$5,active_bytes=active_bytes+$6 WHERE bucket=$1`, bucket, records, bytes, op, activeRecords, activeBytes); err != nil {
		return pg.QueryError("charge webhook bucket", err)
	}
	if _, err := d.tx.Exec(ctx, `UPDATE webhook_quota_owners SET endpoints=endpoints+$3,records=records+$4,bytes=bytes+$5,operations=operations+$6,active_records=active_records+$7,active_bytes=active_bytes+$8 WHERE owner_kind=$1 AND owner_id=$2`, o.Kind, o.ID, endpoints, records, bytes, op, activeRecords, activeBytes); err != nil {
		return pg.QueryError("charge webhook account", err)
	}
	return nil
}

// within tests the delta without overflowing int64.
func within(current, delta, limit int64) bool {
	return current >= 0 && current <= limit && delta >= -current && delta <= limit-current
}
