package project_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestProjectOwnershipCreationAndRequiredReads(t *testing.T) {
	for _, missing := range []string{"ownership", "team"} {
		t.Run(missing, func(t *testing.T) { testProjectOwnershipCreationAndRequiredReads(t, missing) })
	}
}

func testProjectOwnershipCreationAndRequiredReads(t *testing.T, missing string) {
	s := testutil.OpenStore(t, postgres.Open)
	user, principal, _ := testutil.AuthRecords(t, s)
	ctx := context.Background()
	project, err := testutil.CreatePrivateProject(ctx, s, principal, uuid.NewString(), " Raw name ", "git@example.com:owner/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	var owner string
	var grants int
	if err := s.Pool.QueryRow(ctx, `SELECT t.personal_user_id::text,
		(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2 AND role='admin')
		FROM project_ownership o JOIN teams t ON t.id=o.team_id WHERE o.project_id=$1`, project.ID, user.ID).Scan(&owner, &grants); err != nil || owner != user.ID || grants != 1 || project.Ownership.TeamID == "" || project.Ownership.Version != 1 || project.Name != " Raw name " || project.RepoURL != "git@example.com:owner/repo.git" {
		t.Fatalf("incomplete project writer: %#v %s %d %v", project, owner, grants, err)
	}
	if missing == "ownership" {
		testutil.MustExec(t, s.Pool, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
	} else {
		testutil.MustExec(t, s.Pool, `DELETE FROM teams WHERE id=$1`, project.Ownership.TeamID)
	}
	for index, read := range []func(SnapshotScope) error{
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Project(ctx, project.ID)
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 10})
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().AccessibleProjects(ctx, principal, Page{Limit: 10})
			return err
		},
	} {
		if err := s.ReadSnapshot(ctx, read); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("project read %d accepted missing ownership or hid corruption: %v", index, err)
		}
	}
}
