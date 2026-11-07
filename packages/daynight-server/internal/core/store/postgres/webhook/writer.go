package webhook

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type writer struct {
	reader
	owner             wh.Owner
	operationID       string
	configurationLock bool
	operationReserved bool
	configurationCost bool
	budgetLocked      bool
	projectLocks      map[string]bool
}

func NewWriter(tx pgx.Tx, owner wh.Owner, operationID string) store.WebhookWriteDAO {
	return &writer{reader: reader{tx: tx}, owner: owner, operationID: operationID}
}

func sortedIDs(ids []string) []string {
	result := slices.Clone(ids)
	slices.Sort(result)
	return slices.Compact(result)
}

func (w *writer) LockConfiguration(ctx context.Context, request store.WebhookConfigurationLock) error {
	if request.Owner != w.owner || w.configurationLock {
		return fmt.Errorf("Webhook configuration scope does not match its operation")
	}
	projects := sortedIDs(request.ProjectIDs)
	required := make(map[string]bool, len(request.RequiredProjectIDs))
	for _, id := range request.RequiredProjectIDs {
		required[id] = true
	}
	w.projectLocks = map[string]bool{}
	teams := []string{}
	requiredTeams := map[string]bool{}
	if request.Owner.Kind == wh.TeamOwner {
		teams = append(teams, request.Owner.ID)
		requiredTeams[request.Owner.ID] = true
	}
	if request.Expansion {
		for _, id := range projects {
			var locked string
			if err := w.tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
				if errors.Is(err, pgx.ErrNoRows) && !required[id] {
					continue
				}
				return pg.QueryError("lock Webhook Project source", err)
			}
			w.projectLocks[id] = true
		}
		for _, id := range projects {
			if !w.projectLocks[id] {
				continue
			}
			var teamID string
			if err := w.tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR SHARE`, id).Scan(&teamID); err != nil {
				if errors.Is(err, pgx.ErrNoRows) && !required[id] {
					continue
				}
				return pg.QueryError("lock Webhook ownership source", err)
			}
			teams = append(teams, teamID)
			requiredTeams[teamID] = requiredTeams[teamID] || required[id]
		}
	}
	for _, id := range sortedIDs(teams) {
		var locked string
		if err := w.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) && !requiredTeams[id] {
				continue
			}
			return pg.QueryError("lock Webhook Team source", err)
		}
	}
	for _, id := range sortedIDs(teams) {
		if err := lockOptionalRow(ctx, w.tx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, id, request.ActorUserID); err != nil {
			return pg.QueryError("lock Webhook Team authority", err)
		}
	}
	if request.Expansion {
		for _, id := range projects {
			if !w.projectLocks[id] {
				continue
			}
			if err := lockOptionalRow(ctx, w.tx, `SELECT user_id::text FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE`, id, request.ActorUserID); err != nil {
				return pg.QueryError("lock Webhook Project grant", err)
			}
		}
	}
	for id := range required {
		if !w.projectLocks[id] {
			return fmt.Errorf("required Webhook Project is outside its locked source scope")
		}
	}
	if request.EndpointID != "" {
		var id string
		if err := w.tx.QueryRow(ctx, `SELECT id::text FROM webhook_endpoints WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 FOR UPDATE`, request.EndpointID, request.Owner.Kind, request.Owner.ID).Scan(&id); err != nil {
			return pg.QueryError("lock Webhook endpoint", err)
		}
		if err := lockRows(ctx, w.tx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 ORDER BY id FOR UPDATE`, request.EndpointID); err != nil {
			return pg.QueryError("lock Webhook subscriptions", err)
		}
		if err := lockRows(ctx, w.tx, `SELECT b.id::text FROM webhook_bindings b JOIN webhook_subscriptions s ON s.id=b.subscription_id WHERE s.endpoint_id=$1 ORDER BY b.id FOR UPDATE OF b`, request.EndpointID); err != nil {
			return pg.QueryError("lock Webhook event bindings", err)
		}
	}
	w.configurationLock = true
	return nil
}

func lockOptionalRow(ctx context.Context, tx pgx.Tx, statement string, args ...any) error {
	var value string
	err := tx.QueryRow(ctx, statement, args...).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func lockRows(ctx context.Context, tx pgx.Tx, statement string, args ...any) error {
	rows, err := tx.Query(ctx, statement, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (w *writer) InsertEndpoint(ctx context.Context, endpoint wh.Endpoint) error {
	if err := w.requireReserved(endpoint); err != nil {
		return err
	}
	policy, err := w.Policy(ctx)
	if err != nil {
		return err
	}
	var count int64
	if err := w.tx.QueryRow(ctx, `SELECT count(*) FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2 AND deleted_at IS NULL`, endpoint.Owner.Kind, endpoint.Owner.ID).Scan(&count); err != nil {
		return pg.QueryError("count owner Webhook endpoints", err)
	}
	if count >= policy.EndpointLimit {
		return &model.Fault{Code: "subscription_capacity", Message: "Webhook endpoint limit is reached"}
	}
	if err := w.checkFanout(ctx, endpoint, policy); err != nil {
		return err
	}
	_, err = w.tx.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,destination_origin,
        encrypted_destination,active_key_id,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		endpoint.ID, endpoint.Owner.Kind, endpoint.Owner.ID, endpoint.Name, endpoint.Enabled, endpoint.ConfigVersion, endpoint.DestinationRevision,
		endpoint.DestinationKind, endpoint.AdapterVersion, endpoint.DestinationOrigin, destinationCiphertext(endpoint), nullableID(endpoint.ActiveKeyID), endpoint.CreatedAt, endpoint.UpdatedAt, endpoint.DeletedAt)
	if err != nil {
		return pg.QueryError("insert Webhook endpoint", err)
	}
	return w.saveChildren(ctx, endpoint, wh.Endpoint{})
}

func (w *writer) SaveEndpoint(ctx context.Context, endpoint wh.Endpoint, expectedVersion int64) error {
	if err := w.requireReserved(endpoint); err != nil {
		return err
	}
	previous, err := w.Endpoint(ctx, endpoint.Owner, endpoint.ID)
	if err != nil {
		return err
	}
	policy, err := w.Policy(ctx)
	if err != nil {
		return err
	}
	if err := w.checkFanout(ctx, endpoint, policy); err != nil {
		return err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE webhook_endpoints SET name=$4,enabled=$5,config_version=$6,destination_revision=$7,destination_kind=$8,adapter_version=$9,destination_origin=$10,
        encrypted_destination=$11,active_key_id=$12,updated_at=$13,deleted_at=$14 WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND config_version=$15`,
		endpoint.ID, endpoint.Owner.Kind, endpoint.Owner.ID, endpoint.Name, endpoint.Enabled, endpoint.ConfigVersion, endpoint.DestinationRevision,
		endpoint.DestinationKind, endpoint.AdapterVersion, endpoint.DestinationOrigin, destinationCiphertext(endpoint), nullableID(endpoint.ActiveKeyID), endpoint.UpdatedAt, endpoint.DeletedAt, expectedVersion)
	if err != nil {
		return pg.QueryError("save Webhook endpoint", err)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "version_conflict", Message: "Webhook configuration version changed"}
	}
	return w.saveChildren(ctx, endpoint, previous)
}

func (w *writer) requireReserved(endpoint wh.Endpoint) error {
	if !w.configurationLock || !w.configurationCost || !w.operationReserved || endpoint.Owner != w.owner {
		return fmt.Errorf("Webhook configuration was not authorized and reserved in this scope")
	}
	return nil
}

func nullableID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

func destinationCiphertext(endpoint wh.Endpoint) []byte {
	if endpoint.DeletedAt != nil {
		return []byte{}
	}
	return endpoint.EncryptedDestination
}

func (w *writer) checkFanout(ctx context.Context, endpoint wh.Endpoint, policy wh.Policy) error {
	if endpoint.DeletedAt != nil {
		return nil
	}
	count := int64(0)
	pairs := map[string]bool{}
	for _, subscription := range endpoint.Subscriptions {
		if subscription.DeletedAt != nil {
			continue
		}
		count++
		bindings := int64(0)
		for _, binding := range subscription.Bindings {
			if binding.DeletedAt != nil {
				continue
			}
			bindings++
			pair := subscription.ProjectID + "/" + binding.EventType
			if pairs[pair] {
				continue
			}
			pairs[pair] = true
			var matched int64
			err := w.tx.QueryRow(ctx, `SELECT count(DISTINCT s.endpoint_id) FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id
                JOIN webhook_endpoints e ON e.id=s.endpoint_id WHERE s.project_id=$1 AND b.event_type=$2 AND s.deleted_at IS NULL AND b.deleted_at IS NULL AND e.deleted_at IS NULL AND e.id<>$3`, subscription.ProjectID, binding.EventType, endpoint.ID).Scan(&matched)
			if err != nil {
				return pg.QueryError("count Webhook Project fanout", err)
			}
			if matched >= policy.MatchedEndpointsPerProject {
				return &model.Fault{Code: "subscription_capacity", Message: "Webhook Project event fanout limit is reached"}
			}
		}
		if bindings == 0 || bindings > policy.BindingsPerSubscription {
			return &model.Fault{Code: "subscription_capacity", Message: "Webhook event selection limit is exceeded"}
		}
	}
	if count > policy.SubscriptionsPerEndpoint {
		return &model.Fault{Code: "subscription_capacity", Message: "Webhook subscription limit is exceeded"}
	}
	return nil
}

func (w *writer) saveChildren(ctx context.Context, endpoint, previous wh.Endpoint) error {
	oldKeys := map[string]wh.SigningKey{}
	newKeys := map[string]wh.SigningKey{}
	for _, key := range previous.SigningKeys {
		oldKeys[key.ID] = key
	}
	for _, key := range endpoint.SigningKeys {
		newKeys[key.ID] = key
	}
	for _, key := range previous.SigningKeys {
		if _, exists := newKeys[key.ID]; !exists {
			if _, err := w.tx.Exec(ctx, `DELETE FROM webhook_signing_keys WHERE id=$1 AND endpoint_id=$2`, key.ID, endpoint.ID); err != nil {
				return pg.QueryError("retire Webhook signing secret", err)
			}
		}
	}
	for _, key := range endpoint.SigningKeys {
		if _, exists := oldKeys[key.ID]; exists {
			if _, err := w.tx.Exec(ctx, `UPDATE webhook_signing_keys SET encrypted_secret=$3,expires_at=$4,revoked_at=$5 WHERE id=$1 AND endpoint_id=$2`, key.ID, endpoint.ID, key.EncryptedSecret, key.ExpiresAt, key.RevokedAt); err != nil {
				return pg.QueryError("update Webhook signing secret", err)
			}
		}
	}
	for _, key := range endpoint.SigningKeys {
		if _, exists := oldKeys[key.ID]; !exists {
			if _, err := w.tx.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,encrypted_secret,created_at,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6)`, key.ID, endpoint.ID, key.EncryptedSecret, key.CreatedAt, key.ExpiresAt, key.RevokedAt); err != nil {
				return pg.QueryError("insert Webhook signing secret", err)
			}
		}
	}
	oldSubscriptions := map[string]wh.Subscription{}
	for _, subscription := range previous.Subscriptions {
		oldSubscriptions[subscription.ID] = subscription
	}
	for _, subscription := range endpoint.Subscriptions {
		old, exists := oldSubscriptions[subscription.ID]
		if exists {
			if old.ProjectID != subscription.ProjectID {
				return fmt.Errorf("stored Webhook subscription Project cannot change")
			}
			_, err := w.tx.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_state=$3,authorization_epoch=$4,updated_at=$5,deleted_at=$6 WHERE id=$1 AND endpoint_id=$2`,
				subscription.ID, endpoint.ID, subscription.AuthorizationState, subscription.AuthorizationEpoch, endpoint.UpdatedAt, subscription.DeletedAt)
			if err != nil {
				return pg.QueryError("update Webhook subscription", err)
			}
		} else {
			_, err := w.tx.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,owner_kind,owner_id,project_id,authorization_state,authorization_epoch,created_at,updated_at,deleted_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`, subscription.ID, endpoint.ID, endpoint.Owner.Kind, endpoint.Owner.ID, subscription.ProjectID,
				subscription.AuthorizationState, subscription.AuthorizationEpoch, endpoint.UpdatedAt, subscription.DeletedAt)
			if err != nil {
				return pg.QueryError("insert Webhook subscription", err)
			}
		}
		oldBindings := map[string]wh.Binding{}
		for _, binding := range old.Bindings {
			oldBindings[binding.ID] = binding
		}
		for _, binding := range subscription.Bindings {
			if previous, exists := oldBindings[binding.ID]; exists {
				if previous.EventType != binding.EventType {
					return fmt.Errorf("stored Webhook binding event type cannot change")
				}
				if _, err := w.tx.Exec(ctx, `UPDATE webhook_bindings SET deleted_at=$3 WHERE id=$1 AND subscription_id=$2`, binding.ID, subscription.ID, binding.DeletedAt); err != nil {
					return pg.QueryError("retire Webhook event binding", err)
				}
			}
		}
		for _, binding := range subscription.Bindings {
			if _, exists := oldBindings[binding.ID]; !exists {
				if _, err := w.tx.Exec(ctx, `INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at,deleted_at) VALUES($1,$2,$3,$4,$5)`, binding.ID, subscription.ID, binding.EventType, endpoint.UpdatedAt, binding.DeletedAt); err != nil {
					return pg.QueryError("insert Webhook event binding", err)
				}
			}
		}
	}
	return nil
}

func (w *writer) InsertOperation(ctx context.Context, receipt wh.OperationReceipt) error {
	if !w.operationReserved || receipt.Owner != w.owner || receipt.OperationID != w.operationID {
		return fmt.Errorf("Webhook operation receipt does not match its reserved scope")
	}
	fingerprint, err := hex.DecodeString(receipt.Fingerprint)
	if err != nil || len(fingerprint) != 32 {
		return fmt.Errorf("Webhook operation fingerprint is invalid")
	}
	_, err = w.tx.Exec(ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,kind,issued_at,request_sha256,fingerprint,endpoint_id,effect,
        config_version_after,destination_revision_after,delivery_id,generation_after,key_id,signing_overlap_until,recorded_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		receipt.Owner.Kind, receipt.Owner.ID, receipt.OperationID, receipt.ActorUserID, receipt.Kind, receipt.IssuedAt, receipt.RequestSHA256, fingerprint,
		receipt.EndpointID, receipt.Effect, receipt.ConfigVersionAfter, receipt.DestinationRevisionAfter, receipt.DeliveryID, receipt.GenerationAfter, receipt.KeyID, receipt.SigningOverlapUntil, receipt.RecordedAt, receipt.ExpiresAt)
	if err != nil {
		return pg.QueryError("insert Webhook operation receipt", err)
	}
	return nil
}
