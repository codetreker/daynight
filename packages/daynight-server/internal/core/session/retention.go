package session

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const ArchiveRetentionPeriod = 7 * 24 * time.Hour

// CalculateArchiveRetention derives a deadline from current storage facts. An
// unknown terminal or initial archive time remains unknown; upgrade grace does
// not invent either historical timestamp. Already expired decisions are final.
func CalculateArchiveRetention(f store.ArchiveRetentionFacts) (store.ArchiveRetention, error) {
	r := f.Archive
	if r.ExpiredAt != nil {
		return r, nil
	}
	r.ExpiresAt = nil
	r.Members = append([]store.ArchiveRetentionMember(nil), f.Members...)
	if f.State != "ready" {
		r.Reason = "archive_unavailable"
		return r, nil
	}
	if len(f.Members) == 0 {
		return store.ArchiveRetention{}, errors.New("archive retention requires a current ordinary task chain")
	}
	var latest time.Time
	unfinished, unknown := false, false
	for _, m := range f.Members {
		if m.TaskID == "" || m.Version <= 0 {
			return store.ArchiveRetention{}, errors.New("invalid archive retention member identity or version")
		}
		var terminal *time.Time
		switch model.TaskStatus(m.Status) {
		case model.TaskDone:
			terminal = m.CompletedAt
		case model.TaskCancelled:
			terminal = m.CancelledAt
		case model.TaskProposed, model.TaskTodo, model.TaskInProgress:
			unfinished = true
		default:
			return store.ArchiveRetention{}, errors.New("invalid archive retention member status")
		}
		if terminal == nil {
			unknown = true
		} else if terminal.After(latest) {
			latest = *terminal
		}
	}
	if unfinished {
		r.Reason = "chain_unfinished"
		return r, nil
	}
	if unknown {
		r.Reason = "terminal_time_unknown"
		return r, nil
	}
	if r.FirstSucceededAt == nil {
		// A legacy ready archive may use its explicit upgrade lower bound while
		// still exposing that the original success time is unknown.
		if r.GraceUntil == nil {
			r.Reason = "archive_time_unknown"
			return r, nil
		}
		r.Reason = "legacy_grace"
	} else {
		if r.FirstSucceededAt.After(latest) {
			latest = *r.FirstSucceededAt
		}
		r.Reason = "scheduled"
	}
	deadline := latest.UTC().Add(ArchiveRetentionPeriod)
	if r.GraceUntil != nil && r.GraceUntil.After(deadline) {
		deadline = r.GraceUntil.UTC()
	}
	r.ExpiresAt = &deadline
	return r, nil
}

// RefreshArchiveRetention must run in the writer's protected callback. It does
// not authorize access or expire content; directory and cleanup workflows own
// those checks and must not reuse a decision after releasing this scope.
func RefreshArchiveRetention(ctx context.Context, dao store.ArchiveRetentionDAO, project, task, id string) (store.ArchiveRetention, error) {
	facts, err := dao.ArchiveRetentionFacts(ctx, project, task, id)
	if err != nil {
		return store.ArchiveRetention{}, err
	}
	value, err := CalculateArchiveRetention(facts)
	if err != nil {
		return store.ArchiveRetention{}, err
	}
	if value.ExpiredAt != nil {
		return value, nil
	}
	return dao.SaveArchiveRetention(ctx, facts.Archive.Version, value)
}

func (s *Execution) recordArchiveSuccess(ctx context.Context, tx *operationTx, id string) error {
	if dao, ok := tx.dao.(store.SessionArchiveRetentionDAO); ok {
		return dao.RecordSessionArchiveSuccess(ctx, id, s.now().UTC())
	}
	return nil
}
