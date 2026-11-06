package team_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

func TestCreationErrorPreservesIdentifierAndFailure(t *testing.T) {
	cause := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
	failure := &teamservice.CreationError{TeamID: uuid.NewString(), Cause: cause}
	var tx *store.TransactionError
	if failure.TeamID == "" || failure.Error() != cause.Error() || !errors.Is(failure, cause) || !errors.As(failure, &tx) || tx.Outcome != store.TransactionUnknown {
		t.Fatalf("lost creation evidence: %#v", failure)
	}
}
