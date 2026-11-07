package session

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestArchivePreflightDoesNotRevealSessionToNonmember(t *testing.T) {
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	outsider := testsupport.ServicePrincipal(t, f.db)
	for _, id := range []string{snapshot.SessionID, uuid.NewString()} {
		_, err := f.service.BeginArchive(context.Background(), outsider, f.project, f.task, id, core.ArchiveV1Read)
		requireServiceError(t, err, "forbidden")
	}
	_, err := f.service.BeginArchive(context.Background(), f.owner, f.project, f.task, uuid.NewString(), core.ArchiveV1Read)
	requireServiceError(t, err, "not_found")
	if httpx.ErrorKind(err) != "not_found" {
		t.Fatalf("missing session not classified as 404: %v", err)
	}
}

func TestOnlySessionCauseDistinguishesCleanup(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	failure := errors.New("cleanup")
	for _, tc := range []struct {
		name        string
		err, target error
		want        bool
	}{
		{"same", fault, fault, true},
		{"wrapped", fmt.Errorf("wrapped: %w", fault), fault, true},
		{"single join", errors.Join(fault), fault, true},
		{"mixed failure", errors.Join(fault, failure), fault, false},
		{"unrelated", failure, fault, false},
		{"missing row", &store.Error{MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, model.ErrNotFound, true},
		{"missing and cleanup", errors.Join(&store.Error{MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, failure), model.ErrNotFound, false},
		{"database failure", &store.Error{MissingRow: true, DatabaseFailure: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, model.ErrNotFound, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := onlySessionCause(tc.err, tc.target); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
