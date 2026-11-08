package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func fixtureArchiveStatus(f fixture, s *Execution, ctx context.Context, p model.Principal, project, task, id string, work map[string]int) (sp.ArchiveStatus, error) {
	phase := f.ArchivePhase(ctx, mergeFixtureCounts(map[string]int{"SessionArchive": 1}, work))
	defer f.dao.FinishContext(phase)
	return s.ArchiveStatus(phase, p, project, task, id)
}

func fixtureArchiveUpdate(f fixture, s *Execution, ctx context.Context, p model.Principal, project, task, id string, update sp.ArchiveUpdate, work map[string]int) (sp.ArchiveStatus, error) {
	phase := f.ArchivePhase(ctx, mergeFixtureCounts(map[string]int{"SessionArchive": 1}, work))
	defer f.dao.FinishContext(phase)
	return s.UpdateArchive(phase, p, project, task, id, update)
}

func fixtureArchiveIOPhase(f fixture, ctx context.Context, read bool, work map[string]int) context.Context {
	counts := map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "SessionArchive": 1}
	if f.data.Session.Snapshot.TestExecutionID != "" {
		counts["ReadCredential"], counts["ProjectAccess"] = 2, 0
	}
	if read {
		counts["LockArchiveTask"] = 0
		if f.data.Session.Snapshot.TestExecutionID == "" {
			counts["LockTask"] = 1
		}
	}
	return f.ArchivePhase(ctx, mergeFixtureCounts(counts, work))
}

func fixtureArchivePut(f fixture, s *Execution, ctx context.Context, p model.Principal, project, task, id string, data []byte, work map[string]int) (sp.ArchiveStatus, error) {
	phase := fixtureArchiveIOPhase(f, ctx, false, work)
	defer f.dao.FinishContext(phase)
	return s.PutArchive(phase, p, project, task, id, data)
}

func fixtureArchiveContent(f fixture, s *Execution, ctx context.Context, p model.Principal, project, task, id string, work map[string]int) (*RetainedArchive, error) {
	phase := fixtureArchiveIOPhase(f, ctx, true, work)
	defer f.dao.FinishContext(phase)
	return s.ArchiveContent(phase, p, project, task, id)
}

func archivePreflightOnly(readCredential, projectAccess, metadata int) map[string]int {
	return map[string]int{"ReadCredential": readCredential, "ProjectAccess": projectAccess, "ArchiveMetadata": metadata, "LockArchiveTask": 0, "LockTask": 0, "LockCredential": 0, "SessionBotID": 0, "LockSession": 0, "SessionArchive": 0}
}

func archiveTaskRefusal() map[string]int {
	return map[string]int{"LockCredential": 0, "ProjectAccess": 0, "SessionBotID": 0, "LockSession": 0, "SessionArchive": 0}
}
