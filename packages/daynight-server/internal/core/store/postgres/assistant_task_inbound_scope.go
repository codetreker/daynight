package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	"github.com/jackc/pgx/v5"
)

type assistantTaskInboundScope struct {
	*assistanttask.DAO
	webhook *webhook.DAO
	project store.ProjectReader
}

func (s assistantTaskInboundScope) WebhookInboundSources() store.WebhookInboundSourceReader {
	return s.webhook
}
func (s assistantTaskInboundScope) ProjectAccessReader() store.ProjectAccessReader { return s.project }

func (s *Store) WriteAssistantTaskInbound(ctx context.Context, operation func(store.AssistantTaskInboundScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin assistant task inbound", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		return operation(assistantTaskInboundScope{DAO: assistanttask.New(tx), webhook: webhook.New(tx), project: project.NewReader(tx)})
	})
	return teamCompletion("write assistant task inbound", err)
}
