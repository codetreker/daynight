package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/credentialusage"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func validateUsageBatch(events []model.CredentialUsageEvent) error {
	if len(events) == 0 || len(events) > 128 {
		return errors.New("credential usage batch must contain 1 to 128 events")
	}
	previous := ""
	for _, event := range events {
		if event.Kind != model.UsageSubjectPAT && event.Kind != model.UsageSubjectOAuthGrant {
			return errors.New("invalid credential usage kind")
		}
		for _, id := range []string{event.UserID, event.SubjectID} {
			canonical, err := model.CanonicalID(id)
			if err != nil || canonical != id || id == uuid.Nil.String() {
				return errors.New("credential usage ID must be a canonical nonzero UUID")
			}
		}
		if event.At.IsZero() || event.At.Location() != time.UTC || event.At.Nanosecond()%1000 != 0 {
			return errors.New("credential usage time must be a nonzero UTC microsecond")
		}
		key := string(event.Kind) + "/" + event.UserID + "/" + event.SubjectID
		if key <= previous {
			return errors.New("credential usage keys must be unique and ordered")
		}
		previous = key
	}
	return nil
}

func (s *Store) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	if err := validateUsageBatch(events); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, fmt.Errorf("invalid credential usage batch: %w", err)
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.AuthQueryError("begin credential usage", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return credentialusage.Write(ctx, tx, events) })
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.AuthQueryError("credential usage", err)
}
