// Package webhook implements the webhook persistence contract in PostgreSQL.
package webhook

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type DAO struct{ tx pgx.Tx }

func New(tx pgx.Tx) *DAO { return &DAO{tx: tx} }

var _ store.WebhookWriter = (*DAO)(nil)

const endpointColumns = `id::text,owner_kind,owner_id::text,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,destination_origin,destination_configuration,active_key_id::text,created_at,updated_at`

func scanEndpoint(row pgx.Row) (model.Endpoint, error) {
	var e model.Endpoint
	var name, kind, origin, active *string
	var adapter *int64
	err := row.Scan(&e.ID, &e.Owner.Kind, &e.Owner.ID, &name, &e.Enabled, &e.DeletedAt, &e.ConfigVersion, &e.DestinationRevision, &kind, &adapter, &origin, &e.DestinationConfiguration, &active, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return model.Endpoint{}, err
	}
	if e.DeletedAt != nil {
		return e, nil
	}
	if name == nil || kind == nil || adapter == nil || origin == nil || len(e.DestinationConfiguration) == 0 || active == nil {
		return model.Endpoint{}, fmt.Errorf("incomplete endpoint configuration")
	}
	e.Name, e.DestinationKind, e.AdapterVersion, e.Origin, e.ActiveKeyID = *name, *kind, strconv.FormatInt(*adapter, 10), *origin, *active
	return e, nil
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
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("list webhook endpoints", err)
	}
	return out, nil
}
func (d *DAO) SigningKeys(ctx context.Context, id string) ([]model.SigningKey, error) {
	rows, err := d.tx.Query(ctx, `SELECT endpoint_id::text,id::text,slot,secret,created_at,overlap_started_at,overlap_until FROM webhook_signing_keys WHERE endpoint_id=$1 ORDER BY created_at,id`, id)
	if err != nil {
		return nil, pg.QueryError("read webhook keys", err)
	}
	defer rows.Close()
	out := make([]model.SigningKey, 0)
	for rows.Next() {
		var k model.SigningKey
		if err := rows.Scan(&k.EndpointID, &k.ID, &k.Slot, &k.Secret, &k.CreatedAt, &k.OverlapStartedAt, &k.OverlapUntil); err != nil {
			return nil, pg.QueryError("read webhook keys", err)
		}
		out = append(out, k)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook keys", err)
	}
	return out, nil
}
func wireKind(kind string) string {
	switch kind {
	case "endpoint.update":
		return "endpoint.patch"
	case "signing.rotate":
		return "signing-secret.rotate"
	}
	return kind
}
func modelKind(kind string) string {
	switch kind {
	case "endpoint.patch":
		return "endpoint.update"
	case "signing-secret.rotate":
		return "signing.rotate"
	}
	return kind
}
func (d *DAO) Operation(ctx context.Context, o model.Owner, id string) (model.Operation, error) {
	var r model.Operation
	var hash, fingerprint []byte
	var key, mode, delivery *string
	r.Owner = o
	err := d.tx.QueryRow(ctx, `SELECT operation_id::text,actor_user_id::text,kind,endpoint_id::text,issued_at_lexeme,request_sha256,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after::text,signing_mode_after,overlap_until_after,recorded_at,expires_at,delivery_id::text,generation_after FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, o.Kind, o.ID, id).Scan(&r.ID, &r.ActorID, &r.Kind, &r.TargetID, &r.IssuedAt, &hash, &fingerprint, &r.Effect, &r.ConfigVersion, &r.DestinationRevisionAfter, &key, &mode, &r.OverlapUntil, &r.RecordedAt, &r.ExpiresAt, &delivery, &r.GenerationAfter)
	if err != nil {
		return model.Operation{}, pg.QueryError("read webhook operation", err)
	}
	if len(hash) != 32 || len(fingerprint) != 32 {
		return model.Operation{}, pg.QueryError("read webhook operation", fmt.Errorf("invalid operation digest"))
	}
	r.Kind = modelKind(r.Kind)
	r.RequestSHA256 = hex.EncodeToString(hash)
	r.Fingerprint = hex.EncodeToString(fingerprint)
	if key != nil {
		r.ActiveKeyID = *key
	}
	if mode != nil {
		r.SigningMode = *mode
	}
	if delivery != nil {
		r.DeliveryID = *delivery
	}
	return r, nil
}
func (d *DAO) Policy(ctx context.Context, version int64) (model.Policy, error) {
	var p model.Policy
	err := d.tx.QueryRow(ctx, `SELECT version,max_automatic_attempts,automatic_window_seconds,automatic_offsets_seconds,max_manual_operations,payload_retention_seconds,metadata_retention_seconds,operation_retention_seconds,operation_max_age_seconds,operation_future_skew_seconds,http_timeout_seconds,lease_seconds,minimum_failure_wait_seconds,jitter_basis_points,jitter_max_seconds,key_overlap_default_seconds,key_overlap_max_seconds FROM webhook_policies WHERE version=$1`, version).Scan(&p.Version, &p.MaxAutomaticAttempts, &p.AutomaticWindowSeconds, &p.AutomaticOffsetsSeconds, &p.MaxManualOperations, &p.PayloadRetentionSeconds, &p.MetadataRetentionSeconds, &p.OperationRetentionSeconds, &p.OperationMaxAgeSeconds, &p.OperationFutureSkewSeconds, &p.HTTPTimeoutSeconds, &p.LeaseSeconds, &p.MinimumFailureWaitSeconds, &p.JitterBasisPoints, &p.JitterMaxSeconds, &p.KeyOverlapDefaultSeconds, &p.KeyOverlapMaxSeconds)
	if err != nil {
		return model.Policy{}, pg.QueryError("read webhook policy", err)
	}
	return p, nil
}
func (d *DAO) PutEndpoint(ctx context.Context, e model.Endpoint) error {
	var name, kind, origin, active, configuration any
	var adapter, schema any
	if e.DeletedAt == nil {
		if len(e.DestinationConfiguration) < 1 || len(e.DestinationConfiguration) > 262144 {
			return fmt.Errorf("invalid destination configuration length")
		}
		av, err := strconv.ParseInt(e.AdapterVersion, 10, 64)
		if err != nil {
			return fmt.Errorf("parse adapter version: %w", err)
		}
		name, kind, origin, active, configuration = e.Name, e.DestinationKind, e.Origin, e.ActiveKeyID, e.DestinationConfiguration
		adapter, schema = av, int16(1)
	}
	var previousRevision int64
	err := d.tx.QueryRow(ctx, `SELECT destination_revision FROM webhook_endpoints WHERE id=$1`, e.ID).Scan(&previousRevision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return pg.QueryError("read webhook endpoint revision", err)
	}
	newRevision := errors.Is(err, pgx.ErrNoRows) || previousRevision != e.DestinationRevision
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,deleted_at=EXCLUDED.deleted_at,config_version=EXCLUDED.config_version,destination_revision=EXCLUDED.destination_revision,destination_kind=EXCLUDED.destination_kind,adapter_version=EXCLUDED.adapter_version,configuration_schema_version=EXCLUDED.configuration_schema_version,destination_origin=EXCLUDED.destination_origin,destination_configuration=EXCLUDED.destination_configuration,active_key_id=EXCLUDED.active_key_id,updated_at=EXCLUDED.updated_at WHERE webhook_endpoints.owner_kind=EXCLUDED.owner_kind AND webhook_endpoints.owner_id=EXCLUDED.owner_id`, e.ID, e.Owner.Kind, e.Owner.ID, name, e.Enabled, e.DeletedAt, e.ConfigVersion, e.DestinationRevision, kind, adapter, schema, origin, configuration, active, e.CreatedAt, e.UpdatedAt)
	if err != nil {
		return pg.QueryError("save webhook endpoint", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook endpoint owner mismatch")
	}
	if newRevision && e.DeletedAt == nil {
		if _, err := d.tx.Exec(ctx, `INSERT INTO webhook_endpoint_waits(endpoint_id,destination_revision,owner_kind,owner_id,updated_at) VALUES($1,$2,$3,$4,$5)`, e.ID, e.DestinationRevision, e.Owner.Kind, e.Owner.ID, e.UpdatedAt); err != nil {
			return pg.QueryError("initialize webhook endpoint wait", err)
		}
	}
	return nil
}
func (d *DAO) PutSigningKey(ctx context.Context, k model.SigningKey) error {
	if len(k.Secret) != 32 {
		return fmt.Errorf("invalid signing secret length")
	}
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_signing_keys(endpoint_id,id,slot,secret,created_at,overlap_started_at,overlap_until) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET slot=EXCLUDED.slot,secret=EXCLUDED.secret,overlap_started_at=EXCLUDED.overlap_started_at,overlap_until=EXCLUDED.overlap_until WHERE webhook_signing_keys.endpoint_id=EXCLUDED.endpoint_id`, k.EndpointID, k.ID, k.Slot, k.Secret, k.CreatedAt, k.OverlapStartedAt, k.OverlapUntil)
	if err != nil {
		return pg.QueryError("save webhook key", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook key endpoint mismatch")
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
	hash, err := hex.DecodeString(r.RequestSHA256)
	if err != nil {
		return fmt.Errorf("decode request digest: %w", err)
	}
	if len(hash) != 32 {
		return fmt.Errorf("invalid request digest")
	}
	fp, err := hex.DecodeString(r.Fingerprint)
	if err != nil {
		return fmt.Errorf("decode semantic fingerprint: %w", err)
	}
	if len(fp) != 32 {
		return fmt.Errorf("invalid semantic fingerprint")
	}
	var key, mode, delivery any
	if r.ActiveKeyID != "" {
		key = r.ActiveKeyID
	}
	if r.SigningMode != "" {
		mode = r.SigningMode
	}
	if r.DeliveryID != "" {
		delivery = r.DeliveryID
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,recorded_at,expires_at,delivery_id,generation_after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, r.Owner.Kind, r.Owner.ID, r.ID, r.ActorID, r.TargetID, wireKind(r.Kind), r.IssuedAt, hash, fp, r.Effect, r.ConfigVersion, r.DestinationRevisionAfter, key, mode, r.OverlapUntil, r.RecordedAt, r.ExpiresAt, delivery, r.GenerationAfter)
	if err != nil {
		return pg.QueryError("save webhook operation", err)
	}
	return nil
}
