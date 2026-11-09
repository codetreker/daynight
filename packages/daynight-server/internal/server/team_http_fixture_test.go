package server

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type teamHTTPReader struct {
	store.TeamReader
	t    *testing.T
	Read func(context.Context, string, string) (model.Team, error)
	List func(context.Context, string, store.Page) (store.TeamPage, error)
}

func (d teamHTTPReader) Team(ctx context.Context, user, id string) (model.Team, error) {
	return d.Read(ctx, user, id)
}
func (d teamHTTPReader) Teams(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
	return d.List(ctx, user, page)
}

type teamHTTPSnapshot struct {
	store.SnapshotScope
	reader store.TeamReader
}

func (s teamHTTPSnapshot) TeamDAO() store.TeamReader { return s.reader }

type teamHTTPCreator struct {
	store.TeamCreationDAO
	insert func(context.Context, string, string) (model.Team, error)
}

func (d teamHTTPCreator) InsertTeam(ctx context.Context, id, name string) (model.Team, error) {
	return d.insert(ctx, id, name)
}

type teamHTTPWriter struct {
	store.TeamWriteDAO
	read         func(context.Context, string) (model.Team, error)
	rename       func(context.Context, string, string) (model.Team, error)
	occupied     func(context.Context) (bool, error)
	delete       func(context.Context) error
	member       func(context.Context, string) (model.TeamMember, error)
	removeMember func(context.Context, string) error
}

func (d teamHTTPWriter) Team(ctx context.Context, user string) (model.Team, error) {
	return d.read(ctx, user)
}
func (d teamHTTPWriter) Rename(ctx context.Context, user, name string) (model.Team, error) {
	return d.rename(ctx, user, name)
}
func (d teamHTTPWriter) HasProjects(ctx context.Context) (bool, error) { return d.occupied(ctx) }
func (d teamHTTPWriter) Delete(ctx context.Context) error              { return d.delete(ctx) }

func (d teamHTTPWriter) Member(ctx context.Context, user string) (model.TeamMember, error) {
	return d.member(ctx, user)
}
func (d teamHTTPWriter) RemoveMember(ctx context.Context, user string) error {
	return d.removeMember(ctx, user)
}

type teamHTTPWriteScope struct {
	store.TeamWriteScope
	dao         store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s teamHTTPWriteScope) TeamDAO() store.TeamWriteDAO                 { return s.dao }
func (s teamHTTPWriteScope) EligibilityDAO() store.WebhookEligibilityDAO { return s.eligibility }

type teamHTTPEligibility struct {
	store.WebhookEligibilityDAO
	lock func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
}

func (d teamHTTPEligibility) LockAffected(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return d.lock(ctx, f)
}

func teamHTTPCreate(t *testing.T, tx *httpTestStore, p model.Principal, name string) *model.Team {
	t.Helper()
	result := new(model.Team)
	writer, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.CreateTeamCall = func(ctx context.Context, owner string, op func(store.TeamCreationDAO) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, owner, p.UserID)
		err := op(teamHTTPCreator{insert: func(ctx context.Context, id, raw string) (model.Team, error) {
			insert()
			projectHTTPCheck(t, raw, name)
			parsed, err := uuid.Parse(id)
			if err != nil || parsed.Version() != 4 {
				t.Errorf("Team ID is not allocated UUIDv4: %s %v", id, err)
				panic("invalid Team ID")
			}
			at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			*result = model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
			return projectHTTPCopyTeam(*result), nil
		}})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return result
}
func teamHTTPRead(t *testing.T, tx *httpTestStore, p model.Principal, id string, result model.Team, readErr error) {
	t.Helper()
	snapshot, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, Read: func(ctx context.Context, user, gotID string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, gotID, id)
			return projectHTTPCopyTeam(result), readErr
		}}})
	}
}
func teamHTTPList(t *testing.T, tx *httpTestStore, p model.Principal, items []model.Team) {
	t.Helper()
	snapshot, list := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		snapshot()
		return op(teamHTTPSnapshot{reader: teamHTTPReader{t: t, List: func(ctx context.Context, user string, page store.Page) (store.TeamPage, error) {
			list()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, page, store.Page{Limit: 1})
			returned := slices.Clone(items)
			for index := range returned {
				returned[index] = projectHTTPCopyTeam(returned[index])
			}
			return store.TeamPage{Items: returned}, nil
		}}})
	}
}
func teamHTTPWrite(t *testing.T, tx *httpTestStore, p model.Principal, current model.Team, rename *model.Team, remove bool) {
	t.Helper()
	writer, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := teamHTTPWriter{read: func(ctx context.Context, user string) (model.Team, error) {
		read()
		projectHTTPCheck(t, user, p.UserID)
		return projectHTTPCopyTeam(current), nil
	}}
	if rename != nil {
		called := projectHTTPCount(t, 1)
		dao.rename = func(ctx context.Context, user, name string) (model.Team, error) {
			called()
			projectHTTPCheck(t, user, p.UserID)
			projectHTTPCheck(t, name, *rename.Name)
			return projectHTTPCopyTeam(*rename), nil
		}
	}
	var eligibility store.WebhookEligibilityDAO
	if remove {
		occupied, deleted, locked := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		dao.occupied = func(context.Context) (bool, error) { occupied(); return false, nil }
		dao.delete = func(context.Context) error { deleted(); return nil }
		eligibility = teamHTTPEligibility{lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
			locked()
			projectHTTPCheck(t, f, store.WebhookEligibilityFilter{TeamID: current.ID, TeamOwner: true})
			return nil, nil
		}}
	}
	tx.WriteTeamCall = func(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, id, current.ID)
		err := op(teamHTTPWriteScope{dao: dao, eligibility: eligibility})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func teamHTTPExit(t *testing.T, tx *httpTestStore, p model.Principal, current model.Team) {
	t.Helper()
	writer, read, member, removed, locked := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := teamHTTPWriter{
		read: func(ctx context.Context, user string) (model.Team, error) {
			read()
			projectHTTPCheck(t, user, p.UserID)
			return projectHTTPCopyTeam(current), nil
		},
		member: func(ctx context.Context, user string) (model.TeamMember, error) {
			member()
			projectHTTPCheck(t, user, p.UserID)
			return current.Membership, nil
		},
		removeMember: func(ctx context.Context, user string) error {
			removed()
			projectHTTPCheck(t, user, p.UserID)
			return nil
		},
	}
	eligibility := teamHTTPEligibility{lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
		locked()
		projectHTTPCheck(t, f, store.WebhookEligibilityFilter{TeamID: current.ID, UserID: p.UserID})
		return nil, nil
	}}
	tx.WriteTeamCall = func(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, id, current.ID)
		err := op(teamHTTPWriteScope{dao: dao, eligibility: eligibility})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}
