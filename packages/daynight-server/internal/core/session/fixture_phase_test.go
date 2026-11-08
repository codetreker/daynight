package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func mergeFixtureCounts(base, work map[string]int) map[string]int {
	counts := make(map[string]int, len(base)+len(work))
	for name, count := range base {
		counts[name] = count
	}
	for name, count := range work {
		counts[name] = count
	}
	return counts
}

func (f fixture) BrowserPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}
	if f.data.Session != nil && f.data.Session.Snapshot.TestExecutionID != "" {
		counts["LockTask"], counts["ProjectAccess"] = 0, 0
		counts["LockCredential"] = 2
	}
	if f.data.Session != nil && f.data.Session.BotID != nil {
		counts["Bot"] = 1
	}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) ControllerPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	if f.data.Session != nil && f.data.Session.Snapshot.TestExecutionID != "" {
		counts["LockTask"], counts["ProjectAccess"] = 0, 0
		counts["LockCredential"] = 2
	}
	if f.data.Session != nil && f.data.Session.BotID != nil {
		counts["Bot"] = 1
	}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) TaskPhase(ctx context.Context, work map[string]int) context.Context {
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, work))
}

func (f fixture) ArchivePhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}
	if f.data.Session != nil && f.data.Session.Snapshot.TestExecutionID != "" {
		counts["LockArchiveTask"], counts["ProjectAccess"] = 0, 0
		counts["LockCredential"] = 2
	}
	if f.data.Session != nil && f.data.Session.BotID != nil {
		counts["Bot"] = 1
	}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) GrantPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	if f.data.Session != nil && f.data.Session.Snapshot.TestExecutionID != "" {
		counts["LockTask"], counts["ProjectAccess"] = 0, 0
		counts["LockCredential"] = 2
	}
	if f.data.Session != nil && f.data.Session.BotID != nil {
		counts["Bot"] = 1
	}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) RegistrationPhase(ctx context.Context, work map[string]int) context.Context {
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1}, work))
}

func fixtureHandle(f fixture, ctx context.Context, message sp.ControllerMessage, work map[string]int) (map[string]any, error) {
	phase := f.ControllerPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Handle(phase, message)
}

func fixturePoll(f fixture, ctx context.Context, fence sp.ControllerFence, work map[string]int) ([]map[string]any, error) {
	phase := f.ControllerPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Poll(phase, fence)
}

func fixtureSubmit(f fixture, ctx context.Context, principal model.Principal, snapshot sp.Snapshot, command sp.Command, work map[string]int) (sp.Operation, error) {
	phase := f.BrowserPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.Submit(phase, principal, f.project, f.task, snapshot.SessionID, command)
}

func fixtureOperation(f fixture, ctx context.Context, snapshot sp.Snapshot, id string) (sp.Operation, error) {
	phase := f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Operation(phase, f.p, f.project, f.task, snapshot.SessionID, id)
}
