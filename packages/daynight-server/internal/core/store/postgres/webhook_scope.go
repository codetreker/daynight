package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	dbwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type webhookScope struct{ *Snapshot }

func (s *webhookScope) EligibilityDAO() store.WebhookEligibilityDAO    { return eligibility.New(s.tx) }
func (s *webhookScope) WebhookDAO() store.WebhookReader                { return dbwebhook.New(s.tx) }
func (s *webhookScope) WebhookWriter() store.WebhookWriter             { return dbwebhook.New(s.tx) }
func (s *webhookScope) RedeliveryWriter() store.WebhookRedeliveryScope { return dbwebhook.New(s.tx) }

// LockConfigurationSources fences both present and absent relationships through their roots.
func (s *webhookScope) LockConfigurationSources(ctx context.Context, owner webhook.Owner, actor string, projects []string) error {
	ids := append([]string(nil), projects...)
	sort.Strings(ids)
	unique := ids[:0]
	for _, id := range ids {
		if len(unique) == 0 || unique[len(unique)-1] != id {
			unique = append(unique, id)
		}
	}
	teams := map[string]bool{}
	if owner.Kind == "team" {
		teams[owner.ID] = true
	}
	live := make([]string, 0, len(unique))
	for _, id := range unique {
		var deleted bool
		err := s.tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM projects WHERE id=$1 FOR UPDATE`, id).Scan(&deleted)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return pg.QueryError("lock webhook Project", err)
		}
		if !deleted {
			live = append(live, id)
		}
	}
	for _, id := range live {
		var team string
		err := s.tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR SHARE`, id).Scan(&team)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("live project ownership missing")
		}
		if err != nil {
			return pg.QueryError("lock webhook ownership", err)
		}
		teams[team] = true
	}
	teamIDs := make([]string, 0, len(teams))
	for id := range teams {
		teamIDs = append(teamIDs, id)
	}
	sort.Strings(teamIDs)
	for _, id := range teamIDs {
		var found string
		err := s.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, id).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return pg.QueryError("lock webhook Team", err)
		}
	}
	for _, id := range teamIDs {
		var found string
		err := s.tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, id, actor).Scan(&found)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return pg.QueryError("lock webhook membership", err)
		}
	}
	for _, id := range live {
		var found string
		err := s.tx.QueryRow(ctx, `SELECT user_id::text FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE`, id, actor).Scan(&found)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return pg.QueryError("lock webhook grant", err)
		}
	}
	return nil
}
func (s *webhookScope) LockCredential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	return pg.ThreadCredential(ctx, s.tx, p, " FOR SHARE")
}
func (s *webhookScope) LockAuthority(ctx context.Context, o webhook.Owner, user string) error {
	if o.Kind == "personal" {
		if o.ID != user {
			return model.ErrNotFound
		}
		return nil
	}
	if o.Kind != "team" {
		return model.ErrNotFound
	}
	var id string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 AND personal_user_id IS NULL FOR SHARE`, o.ID).Scan(&id); err != nil {
		return pg.QueryError("lock webhook Team", err)
	}
	if err := s.tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, o.ID, user).Scan(&id); err != nil {
		return pg.QueryError("lock webhook membership", err)
	}
	return nil
}
func (s *Store) ReadWebhookSnapshot(ctx context.Context, operation func(store.WebhookReadScope) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(&webhookScope{&Snapshot{tx: tx}}) }, false)
}
func (s *Store) WriteWebhook(ctx context.Context, o webhook.Owner, id string, operation func(store.WebhookWriteScope) error) (store.Completion, error) {
	ownerID, ownerErr := uuid.Parse(o.ID)
	operationID, operationErr := uuid.Parse(id)
	if ownerErr != nil || operationErr != nil || (o.Kind != "personal" && o.Kind != "team") {
		return store.Completion{Outcome: store.TransactionNotCommitted}, fmt.Errorf("invalid webhook operation identity")
	}
	o.ID, id = ownerID.String(), operationID.String()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + o.Kind + "\x00" + o.ID + "\x00" + id))
		key := int64(binary.BigEndian.Uint64(sum[:8]))
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
			return pg.QueryError("fence webhook operation", err)
		}
		return operation(&webhookScope{&Snapshot{tx: tx}})
	})
	return teamCompletion("write webhook", err)
}

var _ store.WebhookTransactions = (*Store)(nil)
