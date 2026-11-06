package project_test

import (
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/google/uuid"
)

func TestDeletedProjectIsExcludedFromAccessAndOwnership(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	reader := project.NewReader(f.tx)
	other := uuid.NewString()
	if _, _, err := project.NewCreation(f.tx, f.owner).InsertProject(ctx, other, "Other", "host:other", f.personal); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("invitation"))
	now := time.Now().UTC()
	if err := project.NewWriter(f.tx, f.project).CreateInvitation(ctx, model.ProjectInvitation{
		ID: uuid.NewString(), CreatedBy: f.owner, TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	teamWriter := team.NewWriter(f.tx, f.team)
	found, err := teamWriter.HasProjects(ctx)
	if err != nil || !found {
		t.Fatalf("live project = %v, %v", found, err)
	}
	exec(t, f.tx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, f.project)
	found, err = teamWriter.HasProjects(ctx)
	if err != nil || found {
		t.Fatalf("deleted project = %v, %v", found, err)
	}
	for _, list := range []func() (store.ProjectPage, error){
		func() (store.ProjectPage, error) { return reader.Projects(ctx, store.Page{Limit: 1}) },
		func() (store.ProjectPage, error) {
			return reader.AccessibleProjects(ctx, principal(f.owner), store.Page{Limit: 1})
		},
	} {
		page, err := list()
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != other || page.HasMore {
			t.Fatalf("live page = %+v, %v", page, err)
		}
	}
	_, err = reader.Invitation(ctx, hash[:])
	checkError(t, err, model.ErrNotFound)
	_, err = reader.DirectProjectMember(ctx, f.owner, f.project)
	checkError(t, err, model.ErrNotFound)
	participants, err := reader.ProjectParticipants(ctx, f.project)
	if err != nil || len(participants) != 0 {
		t.Fatalf("deleted project participants = %+v, %v", participants, err)
	}
	// Retained ownership may reference a Team that has since been deleted.
	exec(t, f.tx, `DELETE FROM teams WHERE id=$1`, f.team)
	for _, read := range []func() error{
		func() error { _, err := reader.Project(ctx, f.project); return err },
		func() error { _, err := reader.ProjectAccess(ctx, principal(f.owner), f.project); return err },
		func() error {
			_, err := project.NewThreadDAO(f.tx).LockProjectAuthorization(ctx, principal(f.owner), f.project)
			return err
		},
	} {
		if err := read(); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted project with missing Team: %v", err)
		}
	}
	if err := f.tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	called := false
	_, err = f.db.WriteProject(ctx, f.project, func(store.ProjectWriteScope) error { called = true; return nil })
	if !errors.Is(err, model.ErrNotFound) || called {
		t.Fatalf("deleted write: called=%v, error=%v", called, err)
	}
}
