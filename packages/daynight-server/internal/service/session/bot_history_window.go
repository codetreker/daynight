package session

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// CommitBotHistoryCheckpoint preserves a confirmed checkpoint even when the
// independently retryable reclamation still has readers or fails afterwards.
func (s *Service) CommitBotHistoryCheckpoint(ctx context.Context, credential string, in sp.BotHistoryCheckpoint) (sp.BotHistoryCheckpointReceipt, error) {
	return commitBotHistoryCheckpoint(ctx, credential, in, s.Execution.CommitBotHistoryCheckpoint, s.reclaimBotHistoryResources)
}

func commitBotHistoryCheckpoint(ctx context.Context, credential string, in sp.BotHistoryCheckpoint, commit func(context.Context, string, sp.BotHistoryCheckpoint) (sp.BotHistoryCheckpointReceipt, error), reclaim func(context.Context, string) error) (sp.BotHistoryCheckpointReceipt, error) {
	receipt, err := commit(ctx, credential, in)
	if err != nil {
		return sp.BotHistoryCheckpointReceipt{}, err
	}
	receipt.CleanupPending = reclaim(ctx, in.SessionID) != nil
	return receipt, nil
}

func (s *Service) reclaimBotHistoryResources(ctx context.Context, id string) error {
	return s.Execution.ReclaimBotHistoryResourcesUsing(ctx, id, s.botHistoryReclaimRunner(id))
}

func (s *Service) botHistoryReclaimRunner(id string) core.BotHistoryReclaimRunner {
	return func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return s.write(ctx, func(store.TransactionOutcome) {}, func(scope store.SessionScope) error {
			dao := scope.SessionDAO()
			// Maintenance touches only queued Session resources. It never acquires
			// a Bot lock after this lock or changes Bot authority and scheduling.
			record, err := dao.LockSession(ctx, id)
			if errors.Is(err, model.ErrNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			return work(dao, record)
		})
	}
}

func (s *Service) reclaimBotHistoryAfterRead(ctx context.Context, id string) error {
	err := s.reclaimBotHistoryResources(ctx, id)
	if botHistoryReaderBusy(err) {
		return nil
	}
	return err
}

func botHistoryReaderBusy(err error) bool {
	var fault *model.Fault
	var transaction *store.TransactionError
	return errors.As(err, &fault) && fault.Code == "resource_busy" && !errors.As(err, &transaction) && onlySessionCause(err, fault)
}

// SweepBotHistoryReclaims resumes durable resource cleanup independently of
// Controller activity and archive retention. The runner owns its lifetime.
func (s *Service) SweepBotHistoryReclaims(ctx context.Context, after string) (string, error) {
	return sweepBotHistoryReclaims(ctx, after, s.botHistoryReclaimSessions, s.reclaimBotHistoryResources)
}

func (s *Service) botHistoryReclaimSessions(ctx context.Context, after string, limit int) ([]string, error) {
	var ids []string
	err := s.write(ctx, func(store.TransactionOutcome) {}, func(scope store.SessionScope) error {
		dao, ok := scope.SessionDAO().(store.BotHistoryReclaimInventoryDAO)
		if !ok {
			return errors.New("Bot history cleanup inventory is unavailable")
		}
		var err error
		ids, err = dao.BotHistoryReclaimSessions(ctx, after, limit)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

func sweepBotHistoryReclaims(ctx context.Context, after string, list func(context.Context, string, int) ([]string, error), reclaim func(context.Context, string) error) (string, error) {
	ids, err := list(ctx, after, 32)
	if err != nil {
		return after, err
	}
	var result error
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return after, errors.Join(result, err)
		}
		attempt, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := reclaim(attempt, id)
		cancel()
		if !botHistoryReaderBusy(err) {
			result = errors.Join(result, err)
		}
		after = id
	}
	if len(ids) < 32 {
		after = ""
	}
	return after, result
}
