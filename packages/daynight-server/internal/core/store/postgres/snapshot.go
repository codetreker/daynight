package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Snapshot struct {
	tx pgx.Tx
}

func (s *Store) ReadSnapshot(ctx context.Context, operation func(SnapshotScope) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(&Snapshot{tx: tx}) }, false)
}

// ReadOnlySnapshot shares transaction completion semantics with driver adapters.
func ReadOnlySnapshot(ctx context.Context, pool *pgxpool.Pool, operation func(pgx.Tx) error) error {
	return readSnapshot(ctx, pool, operation, true)
}

func readSnapshot(ctx context.Context, pool *pgxpool.Pool, operation func(pgx.Tx) error, closedConnectionCleanup bool) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return pg.QueryError("begin snapshot", err)
	}
	var completion error
	if closedConnectionCleanup {
		completion = transactReadOnly(ctx, tx, operation)
	} else {
		completion = transact(ctx, tx, operation)
	}
	if completion != nil {
		return pg.QueryError("snapshot", completion)
	}
	return nil
}

func (s *Snapshot) CredentialDAO() CredentialReader { return s }
func (s *Snapshot) TeamDAO() TeamReader             { return team.NewReader(s.tx) }
func (s *Snapshot) ProjectDAO() ProjectReader       { return project.NewReader(s.tx) }
func (s *Snapshot) TaskDAO() TaskReader             { return task.NewReader(s.tx) }
func (s *Snapshot) WorkerDAO() WorkerReader         { return worker.NewReader(s.tx) }
func (s *Snapshot) SessionDAO() SessionReader       { return session.NewReader(s.tx) }
func (s *Snapshot) BotDAO() BotReader               { return bot.NewReader(s.tx) }
func (s *Snapshot) AttachmentDAO() AttachmentReader { return attachment.NewReader(s.tx) }
func (s *Snapshot) GitHubDAO() GitHubReadDAO        { return github.NewReader(s.tx) }
