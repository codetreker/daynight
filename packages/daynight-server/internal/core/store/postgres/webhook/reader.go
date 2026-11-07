package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/jackc/pgx/v5"
)

type reader struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.WebhookReadDAO { return &reader{tx: tx} }

func (r *reader) OwnerAccess(ctx context.Context, owner wh.Owner, actorID string) (wh.OwnerAccess, error) {
	if owner.Kind == wh.PersonalOwner {
		var exists bool
		if err := r.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, owner.ID).Scan(&exists); err != nil {
			return wh.OwnerAccess{}, pg.QueryError("read personal Webhook owner", err)
		}
		return wh.OwnerAccess{CanRead: exists && actorID == owner.ID, CanManage: exists && actorID == owner.ID}, nil
	}
	if owner.Kind != wh.TeamOwner {
		return wh.OwnerAccess{}, fmt.Errorf("stored Webhook owner kind is invalid")
	}
	var read, manage bool
	err := r.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.id=$1 AND t.personal_user_id IS NULL AND m.user_id=$2),
        EXISTS(SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.id=$1 AND t.personal_user_id IS NULL AND m.user_id=$2 AND m.role='admin')`, owner.ID, actorID).Scan(&read, &manage)
	if err != nil {
		return wh.OwnerAccess{}, pg.QueryError("read shared Webhook owner", err)
	}
	return wh.OwnerAccess{CanRead: read, CanManage: manage}, nil
}

const endpointColumns = `id::text,owner_kind,owner_id::text,name,enabled,config_version,destination_revision,destination_kind,adapter_version,destination_origin,encrypted_destination,active_key_id::text,created_at,updated_at,deleted_at`

func scanEndpoint(row pgx.Row) (wh.Endpoint, error) {
	var endpoint wh.Endpoint
	var activeKey *string
	err := row.Scan(&endpoint.ID, &endpoint.Owner.Kind, &endpoint.Owner.ID, &endpoint.Name, &endpoint.Enabled, &endpoint.ConfigVersion,
		&endpoint.DestinationRevision, &endpoint.DestinationKind, &endpoint.AdapterVersion, &endpoint.DestinationOrigin, &endpoint.EncryptedDestination,
		&activeKey, &endpoint.CreatedAt, &endpoint.UpdatedAt, &endpoint.DeletedAt)
	if err != nil {
		return wh.Endpoint{}, err
	}
	if activeKey != nil {
		endpoint.ActiveKeyID = *activeKey
	}
	if endpoint.ConfigVersion <= 0 || endpoint.DestinationRevision <= 0 || endpoint.AdapterVersion <= 0 || endpoint.Owner.Kind != wh.PersonalOwner && endpoint.Owner.Kind != wh.TeamOwner {
		return wh.Endpoint{}, fmt.Errorf("stored Webhook endpoint is invalid")
	}
	endpoint.CreatedAt, endpoint.UpdatedAt, endpoint.DeletedAt = endpoint.CreatedAt.UTC(), endpoint.UpdatedAt.UTC(), pg.UTCTime(endpoint.DeletedAt)
	endpoint.SigningKeys = []wh.SigningKey{}
	endpoint.Subscriptions = []wh.Subscription{}
	return endpoint, nil
}

func (r *reader) Endpoint(ctx context.Context, owner wh.Owner, id string) (wh.Endpoint, error) {
	endpoint, err := scanEndpoint(r.tx.QueryRow(ctx, `SELECT `+endpointColumns+` FROM webhook_endpoints WHERE id=$1 AND owner_kind=$2 AND owner_id=$3`, id, owner.Kind, owner.ID))
	if err != nil {
		return wh.Endpoint{}, pg.QueryError("read Webhook endpoint", err)
	}
	if err := r.loadConfiguration(ctx, &endpoint); err != nil {
		return wh.Endpoint{}, err
	}
	return endpoint, nil
}

func (r *reader) loadConfiguration(ctx context.Context, endpoint *wh.Endpoint) error {
	rows, err := r.tx.Query(ctx, `SELECT id::text,encrypted_secret,created_at,expires_at,revoked_at FROM webhook_signing_keys WHERE endpoint_id=$1 ORDER BY created_at,id`, endpoint.ID)
	if err != nil {
		return pg.QueryError("read Webhook signing keys", err)
	}
	for rows.Next() {
		var key wh.SigningKey
		if err = rows.Scan(&key.ID, &key.EncryptedSecret, &key.CreatedAt, &key.ExpiresAt, &key.RevokedAt); err != nil {
			break
		}
		key.CreatedAt, key.ExpiresAt, key.RevokedAt = key.CreatedAt.UTC(), pg.UTCTime(key.ExpiresAt), pg.UTCTime(key.RevokedAt)
		endpoint.SigningKeys = append(endpoint.SigningKeys, key)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("read Webhook signing keys", err)
	}
	rows, err = r.tx.Query(ctx, `SELECT id::text,project_id::text,authorization_state,authorization_epoch,deleted_at FROM webhook_subscriptions WHERE endpoint_id=$1 ORDER BY id`, endpoint.ID)
	if err != nil {
		return pg.QueryError("read Webhook subscriptions", err)
	}
	for rows.Next() {
		var subscription wh.Subscription
		if err = rows.Scan(&subscription.ID, &subscription.ProjectID, &subscription.AuthorizationState, &subscription.AuthorizationEpoch, &subscription.DeletedAt); err != nil {
			break
		}
		if subscription.AuthorizationEpoch <= 0 || subscription.AuthorizationState != wh.AuthorizationActive && subscription.AuthorizationState != wh.AuthorizationConfirmationRequired {
			err = fmt.Errorf("stored Webhook subscription authorization is invalid")
			break
		}
		subscription.DeletedAt = pg.UTCTime(subscription.DeletedAt)
		subscription.Bindings = []wh.Binding{}
		endpoint.Subscriptions = append(endpoint.Subscriptions, subscription)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return pg.QueryError("read Webhook subscriptions", err)
	}
	for i := range endpoint.Subscriptions {
		subscription := &endpoint.Subscriptions[i]
		rows, err = r.tx.Query(ctx, `SELECT id::text,event_type,deleted_at FROM webhook_bindings WHERE subscription_id=$1 ORDER BY id`, subscription.ID)
		if err != nil {
			return pg.QueryError("read Webhook event bindings", err)
		}
		for rows.Next() {
			var binding wh.Binding
			if err = rows.Scan(&binding.ID, &binding.EventType, &binding.DeletedAt); err != nil {
				break
			}
			binding.DeletedAt = pg.UTCTime(binding.DeletedAt)
			subscription.Bindings = append(subscription.Bindings, binding)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return pg.QueryError("read Webhook event bindings", err)
		}
	}
	if endpoint.DeletedAt == nil {
		found := false
		for _, key := range endpoint.SigningKeys {
			found = found || key.ID == endpoint.ActiveKeyID && key.RevokedAt == nil && key.ExpiresAt == nil
		}
		if !found {
			return pg.QueryError("read Webhook configuration", fmt.Errorf("active signing key is missing or inconsistent"))
		}
	}
	return nil
}

func (r *reader) Endpoints(ctx context.Context, owner wh.Owner, actorID string, query store.WebhookEndpointQuery) (store.WebhookEndpointPage, error) {
	afterTime, afterID := pg.PageValues(query.Page)
	rows, err := r.tx.Query(ctx, `SELECT id::text FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2 AND deleted_at IS NULL
        AND ($3::boolean IS NULL OR enabled=$3) AND ($4='' OR strpos(lower(name),lower($4))>0 OR strpos(lower(destination_origin),lower($4))>0)
        AND ($5::timestamptz IS NULL OR (created_at,id)>($5,$6::uuid)) ORDER BY created_at,id LIMIT $7`,
		owner.Kind, owner.ID, query.Enabled, query.Search, afterTime, afterID, query.Page.Limit+1)
	if err != nil {
		return store.WebhookEndpointPage{}, pg.QueryError("list Webhook endpoints", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return store.WebhookEndpointPage{}, pg.QueryError("list Webhook endpoints", err)
	}
	page := store.WebhookEndpointPage{Items: []wh.Endpoint{}, HasMore: len(ids) > query.Page.Limit}
	if page.HasMore {
		ids = ids[:query.Page.Limit]
	}
	for _, id := range ids {
		endpoint, err := r.Endpoint(ctx, owner, id)
		if err != nil {
			return store.WebhookEndpointPage{}, err
		}
		page.Items = append(page.Items, endpoint)
	}
	return page, nil
}

func (r *reader) Projects(ctx context.Context, owner wh.Owner, actorID string, ids []string) ([]wh.ProjectAccess, error) {
	result := make([]wh.ProjectAccess, 0, len(ids))
	for _, id := range ids {
		var item wh.ProjectAccess
		var name, teamID *string
		var ownerTeamID *string
		var canRead bool
		err := r.tx.QueryRow(ctx, `SELECT p.name,o.team_id::text,t.id::text,EXISTS(SELECT 1 FROM (`+pg.ProjectAccessRelation+`) a WHERE a.project_id=p.id AND a.user_id=$2)
            FROM projects p LEFT JOIN project_ownership o ON o.project_id=p.id LEFT JOIN teams t ON t.id=o.team_id WHERE p.id=$1 AND p.deleted_at IS NULL`, id, actorID).Scan(&name, &teamID, &ownerTeamID, &canRead)
		item.ProjectID = id
		if errors.Is(err, pgx.ErrNoRows) {
			result = append(result, item)
			continue
		}
		if err != nil {
			return nil, pg.QueryError("read Webhook project eligibility", err)
		}
		if teamID == nil || ownerTeamID == nil {
			return nil, pg.QueryError("read Webhook project eligibility", fmt.Errorf("project ownership is missing"))
		}
		item.Present, item.CanRead, item.OwnerTeamID = true, canRead, *teamID
		if canRead {
			item.ProjectName = name
		}
		result = append(result, item)
	}
	return result, nil
}

func (r *reader) Operation(ctx context.Context, owner wh.Owner, id string) (wh.OperationReceipt, error) {
	var receipt wh.OperationReceipt
	var fingerprint []byte
	err := r.tx.QueryRow(ctx, `SELECT operation_id::text,kind,issued_at,request_sha256,fingerprint,actor_user_id::text,owner_kind,owner_id::text,endpoint_id::text,effect,
        config_version_after,destination_revision_after,delivery_id::text,generation_after,key_id::text,signing_overlap_until,recorded_at,expires_at
        FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3 AND expires_at>statement_timestamp()`, owner.Kind, owner.ID, id).Scan(
		&receipt.OperationID, &receipt.Kind, &receipt.IssuedAt, &receipt.RequestSHA256, &fingerprint, &receipt.ActorUserID, &receipt.Owner.Kind, &receipt.Owner.ID,
		&receipt.EndpointID, &receipt.Effect, &receipt.ConfigVersionAfter, &receipt.DestinationRevisionAfter, &receipt.DeliveryID, &receipt.GenerationAfter,
		&receipt.KeyID, &receipt.SigningOverlapUntil, &receipt.RecordedAt, &receipt.ExpiresAt)
	if err != nil {
		return wh.OperationReceipt{}, pg.QueryError("read Webhook operation", err)
	}
	if len(fingerprint) != sha256.Size {
		return wh.OperationReceipt{}, pg.QueryError("read Webhook operation", fmt.Errorf("stored request fingerprint is invalid"))
	}
	receipt.Fingerprint = hex.EncodeToString(fingerprint)
	receipt.RecordedAt, receipt.ExpiresAt = receipt.RecordedAt.UTC(), receipt.ExpiresAt.UTC()
	receipt.SigningOverlapUntil = pg.UTCTime(receipt.SigningOverlapUntil)
	return receipt, nil
}

func (r *reader) Policy(ctx context.Context) (wh.Policy, error) {
	var data, digest []byte
	var version int64
	err := r.tx.QueryRow(ctx, `SELECT version,parameters,sha256 FROM webhook_policies ORDER BY version DESC LIMIT 1`).Scan(&version, &data, &digest)
	if err != nil {
		return wh.Policy{}, pg.QueryError("read Webhook policy", err)
	}
	actual := sha256.Sum256(data)
	if !bytes.Equal(actual[:], digest) {
		return wh.Policy{}, pg.QueryError("read Webhook policy", fmt.Errorf("policy checksum is inconsistent"))
	}
	typeOfPolicy := reflect.TypeOf(wh.Policy{})
	allowed := make([]string, 0, typeOfPolicy.NumField())
	for i := 0; i < typeOfPolicy.NumField(); i++ {
		allowed = append(allowed, typeOfPolicy.Field(i).Tag.Get("json"))
	}
	if _, err := jsonobject.Decode(data, "Webhook policy", allowed...); err != nil {
		return wh.Policy{}, pg.QueryError("decode Webhook policy", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var policy wh.Policy
	if err := decoder.Decode(&policy); err != nil {
		return wh.Policy{}, pg.QueryError("decode Webhook policy", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF || policy.Version != version || !reflect.DeepEqual(policy, wh.DefaultPolicy()) {
		return wh.Policy{}, pg.QueryError("read Webhook policy", fmt.Errorf("unsupported Webhook policy"))
	}
	return policy, nil
}
