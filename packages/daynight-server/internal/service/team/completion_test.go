package team_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

type failedSnapshot struct {
	store.TeamWriter
	store.SnapshotScope
	store.TeamReader
	err error
}

func (f failedSnapshot) ReadSnapshot(_ context.Context, op func(store.SnapshotScope) error) error {
	if err := op(f); err != nil {
		return err
	}
	return f.err
}
func (f failedSnapshot) TeamDAO() store.TeamReader { return f }
func (f failedSnapshot) Teams(context.Context, string, store.Page) (store.TeamPage, error) {
	return store.TeamPage{Items: []model.Team{{ID: uuid.NewString()}}}, nil
}
func TestListDiscardsResultsWhenSnapshotCompletionFails(t *testing.T) {
	failure := errors.New("snapshot cleanup failed")
	s := teamservice.NewTeams(failedSnapshot{err: failure})
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	page, err := s.List(context.Background(), p, model.PageRequest{Limit: 10})
	if !errors.Is(err, failure) || page.Items != nil || page.NextCursor != nil {
		t.Fatalf("page %#v error %v", page, err)
	}
}

type unconfirmedCreation struct {
	store.TeamWriter
	store.SnapshotReader
	transaction *store.TransactionError
	allocated   string
	calls       int
}
type unconfirmedCreator struct {
	store.TeamCreationDAO
	db *unconfirmedCreation
}

func (d *unconfirmedCreation) CreateTeam(_ context.Context, _ string, operation func(store.TeamCreationDAO) error) (store.Completion, error) {
	d.calls++
	if err := operation(unconfirmedCreator{db: d}); err != nil {
		return store.Completion{}, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, d.transaction
}
func (d unconfirmedCreator) InsertTeam(_ context.Context, id, name string) (model.Team, error) {
	d.db.allocated = id
	return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}}, nil
}

func TestCreationErrorPreservesIdentifierAndFailure(t *testing.T) {
	cause := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
	db := &unconfirmedCreation{transaction: cause}
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	team, err := teamservice.NewTeams(db).Create(context.Background(), p, coreteam.CreateTeam{Name: "Example", ExpectedUserID: p.UserID})
	var failure *teamservice.CreationError
	var tx *store.TransactionError
	if team.ID != "" || db.calls != 1 || !errors.As(err, &failure) || failure.TeamID != db.allocated || uuid.Validate(failure.TeamID) != nil || err.Error() != cause.Error() || !errors.Is(err, cause) || !errors.As(err, &tx) || tx.Outcome != store.TransactionUnknown {
		t.Fatalf("lost creation evidence: team=%#v error=%#v", team, err)
	}
}
