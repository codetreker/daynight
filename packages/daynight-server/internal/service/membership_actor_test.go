package service

import (
	"context"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMembershipExpectedActorRejectsBeforeDomainSQL(t *testing.T) {
	_, database, databaseURL, actor := projectService(t)
	project, err := NewProjects(database).Create(context.Background(), actor, CreateProject{Name: "Identity guard", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	target := workerMember(t, database, project.ID)
	var before core.ProjectMember
	if err := database.ReadSnapshot(context.Background(), func(snapshot *store.Snapshot) error {
		var err error
		before, err = snapshot.DirectProjectMember(context.Background(), target.UserID, project.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var queries atomic.Int32
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(string) bool { queries.Add(1); return false }})
	memberships := NewMemberships(traced.store)
	_, err = memberships.SetRole(context.Background(), actor, project.ID, target.UserID, SetProjectMemberRole{Version: before.Grant.Version, Role: core.ProjectAdmin, ExpectedUserID: target.UserID})
	requireFault(t, err, "identity_mismatch")
	err = memberships.Remove(context.Background(), actor, project.ID, target.UserID, RemoveProjectMember{Version: before.Grant.Version, ExpectedUserID: target.UserID})
	requireFault(t, err, "identity_mismatch")
	if queries.Load() != 0 {
		t.Fatalf("identity mismatch executed %d queries", queries.Load())
	}
	if err := database.ReadSnapshot(context.Background(), func(snapshot *store.Snapshot) error {
		after, err := snapshot.DirectProjectMember(context.Background(), target.UserID, project.ID)
		if err == nil && !reflect.DeepEqual(before, after) {
			t.Fatal("identity mismatch changed the direct grant")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMembershipExpectedActorRequiresCanonicalIdentity(t *testing.T) {
	ctx := context.Background()
	actor := core.Principal{Kind: core.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	projectID, targetID := uuid.NewString(), uuid.NewString()
	memberships := NewMemberships(nil)
	for _, expected := range []string{"", "invalid", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")} {
		_, err := memberships.SetRole(ctx, actor, projectID, targetID, SetProjectMemberRole{Version: 1, Role: core.ProjectAdmin, ExpectedUserID: expected})
		requireFault(t, err, "invalid_input")
		err = memberships.Remove(ctx, actor, projectID, targetID, RemoveProjectMember{Version: 1, ExpectedUserID: expected})
		requireFault(t, err, "invalid_input")
	}
}
