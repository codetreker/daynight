// Package webhook implements the webhook persistence contract in PostgreSQL.
package webhook

import (
	"context"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5"
)

type DAO struct{ tx pgx.Tx }

func New(tx pgx.Tx) *DAO { return &DAO{tx: tx} }

var _ store.WebhookWriter = (*DAO)(nil)

const endpointColumns = `id::text,owner_kind,owner_id::text,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id::text,created_at,updated_at`

func scanEndpoint(row pgx.Row) (model.Endpoint, error) {
	var e model.Endpoint
	var name, kind, origin, master, active *string
	var adapter *int64
	var version *int16
	var nonce, ciphertext []byte
	err := row.Scan(&e.ID, &e.Owner.Kind, &e.Owner.ID, &name, &e.Enabled, &e.DeletedAt, &e.ConfigVersion, &e.DestinationRevision, &kind, &adapter, &origin, &version, &master, &nonce, &ciphertext, &active, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return model.Endpoint{}, err
	}
	if e.DeletedAt != nil {
		return e, nil
	}
	if name == nil || kind == nil || adapter == nil || origin == nil || version == nil || master == nil || active == nil {
		return model.Endpoint{}, fmt.Errorf("incomplete endpoint ciphertext or configuration")
	}
	e.Name, e.DestinationKind, e.AdapterVersion, e.Origin, e.ActiveKeyID = *name, *kind, strconv.FormatInt(*adapter, 10), *origin, *active
	e.DestinationCiphertext, err = (secretbox.Envelope{Version: int(*version), MasterKeyID: *master, Nonce: nonce, Ciphertext: ciphertext}).MarshalBinary()
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
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("list webhook endpoints", err)
	}
	return out, nil
}
func (d *DAO) SigningKeys(ctx context.Context, id string) ([]model.SigningKey, error) {
	rows, err := d.tx.Query(ctx, `SELECT endpoint_id::text,id::text,slot,envelope_version,master_key_id,nonce,ciphertext,created_at,overlap_started_at,overlap_until FROM webhook_signing_keys WHERE endpoint_id=$1 ORDER BY created_at,id`, id)
	if err != nil {
		return nil, pg.QueryError("read webhook keys", err)
	}
	defer rows.Close()
	out := make([]model.SigningKey, 0)
	for rows.Next() {
		var k model.SigningKey
		var e secretbox.Envelope
		if err := rows.Scan(&k.EndpointID, &k.ID, &k.Slot, &e.Version, &e.MasterKeyID, &e.Nonce, &e.Ciphertext, &k.CreatedAt, &k.OverlapStartedAt, &k.OverlapUntil); err != nil {
			return nil, pg.QueryError("read webhook keys", err)
		}
		k.Ciphertext, err = e.MarshalBinary()
		if err != nil {
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
	var key, mode *string
	r.Owner = o
	err := d.tx.QueryRow(ctx, `SELECT operation_id::text,actor_user_id::text,kind,endpoint_id::text,issued_at_lexeme,request_sha256,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after::text,signing_mode_after,overlap_until_after,recorded_at,expires_at FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, o.Kind, o.ID, id).Scan(&r.ID, &r.ActorID, &r.Kind, &r.TargetID, &r.IssuedAt, &hash, &fingerprint, &r.Effect, &r.ConfigVersion, &r.DestinationRevisionAfter, &key, &mode, &r.OverlapUntil, &r.RecordedAt, &r.ExpiresAt)
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
	var name, kind, origin, master, active any
	var adapter, schema, ver, nonce, cipher any
	if e.DeletedAt == nil {
		env, err := secretbox.ParseEnvelope(e.DestinationCiphertext)
		if err != nil {
			return fmt.Errorf("parse destination envelope: %w", err)
		}
		av, err := strconv.ParseInt(e.AdapterVersion, 10, 64)
		if err != nil {
			return fmt.Errorf("parse adapter version: %w", err)
		}
		name, kind, origin, master, active = e.Name, e.DestinationKind, e.Origin, env.MasterKeyID, e.ActiveKeyID
		adapter, schema, ver, nonce, cipher = av, int16(1), int16(env.Version), env.Nonce, env.Ciphertext
	}
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,deleted_at,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,deleted_at=EXCLUDED.deleted_at,config_version=EXCLUDED.config_version,destination_revision=EXCLUDED.destination_revision,destination_kind=EXCLUDED.destination_kind,adapter_version=EXCLUDED.adapter_version,configuration_schema_version=EXCLUDED.configuration_schema_version,destination_origin=EXCLUDED.destination_origin,destination_envelope_version=EXCLUDED.destination_envelope_version,destination_master_key_id=EXCLUDED.destination_master_key_id,destination_nonce=EXCLUDED.destination_nonce,destination_ciphertext=EXCLUDED.destination_ciphertext,active_key_id=EXCLUDED.active_key_id,updated_at=EXCLUDED.updated_at WHERE webhook_endpoints.owner_kind=EXCLUDED.owner_kind AND webhook_endpoints.owner_id=EXCLUDED.owner_id`, e.ID, e.Owner.Kind, e.Owner.ID, name, e.Enabled, e.DeletedAt, e.ConfigVersion, e.DestinationRevision, kind, adapter, schema, origin, ver, master, nonce, cipher, active, e.CreatedAt, e.UpdatedAt)
	if err != nil {
		return pg.QueryError("save webhook endpoint", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook endpoint owner mismatch")
	}
	return nil
}
func (d *DAO) PutSigningKey(ctx context.Context, k model.SigningKey) error {
	e, err := secretbox.ParseEnvelope(k.Ciphertext)
	if err != nil {
		return fmt.Errorf("parse signing envelope: %w", err)
	}
	tag, err := d.tx.Exec(ctx, `INSERT INTO webhook_signing_keys(endpoint_id,id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at,overlap_started_at,overlap_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET slot=EXCLUDED.slot,envelope_version=EXCLUDED.envelope_version,master_key_id=EXCLUDED.master_key_id,nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,overlap_started_at=EXCLUDED.overlap_started_at,overlap_until=EXCLUDED.overlap_until WHERE webhook_signing_keys.endpoint_id=EXCLUDED.endpoint_id`, k.EndpointID, k.ID, k.Slot, e.Version, e.MasterKeyID, e.Nonce, e.Ciphertext, k.CreatedAt, k.OverlapStartedAt, k.OverlapUntil)
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
	var key, mode any
	if r.ActiveKeyID != "" {
		key = r.ActiveKeyID
	}
	if r.SigningMode != "" {
		mode = r.SigningMode
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,recorded_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, r.Owner.Kind, r.Owner.ID, r.ID, r.ActorID, r.TargetID, wireKind(r.Kind), r.IssuedAt, hash, fp, r.Effect, r.ConfigVersion, r.DestinationRevisionAfter, key, mode, r.OverlapUntil, r.RecordedAt, r.ExpiresAt)
	if err != nil {
		return pg.QueryError("save webhook operation", err)
	}
	return nil
}
