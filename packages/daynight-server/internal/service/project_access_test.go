package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestProjectAccessProjectionAndAuthorization(t *testing.T) {
	f := newMembershipFixture(t)
	admin, member, outsider := f.user(t), f.user(t), f.user(t)
	project := f.project(t, admin, "Access projection")
	joined := f.join(t, admin, member, project.ID)
	ctx := context.Background()
	if _, err := f.database.Pool.Exec(ctx, `UPDATE project_grants SET version=9007199254740993 WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	joined.Grant.Version = 9007199254740993
	for _, test := range []struct {
		principal model.Principal
		grant     model.ProjectGrant
	}{
		{admin, f.member(t, admin, project.ID).Grant},
		{member, joined.Grant},
	} {
		access, err := f.projects.Access(ctx, test.principal, strings.ToUpper(project.ID))
		if err != nil || (access.ProjectID != project.ID || access.UserID != test.principal.UserID || access.Role != test.grant.Role || !reflect.DeepEqual(access.DirectGrant, &test.grant)) {
			t.Fatalf("current actor access: %#v %v", access, err)
		}
	}
	for _, test := range []struct {
		principal model.Principal
		projectID string
	}{
		{outsider, project.ID},
		{admin, uuid.NewString()},
	} {
		access, err := f.projects.Access(ctx, test.principal, test.projectID)
		requireFault(t, err, "not_found")
		if !reflect.DeepEqual(access, model.ProjectAccess{}) {
			t.Fatal("inaccessible project returned actor data")
		}
	}
}

func TestProjectAccessValidationAndCompletionFailures(t *testing.T) {
	ctx := context.Background()
	_, err := NewProjects(nil).Access(ctx, model.Principal{}, uuid.NewString())
	requireFault(t, err, "unauthenticated")
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err = NewProjects(nil).Access(ctx, principal, "invalid")
	requireFault(t, err, "invalid_input")
	projects, database, databaseURL, admin := projectService(t)
	project, err := projects.Create(ctx, admin, CreateProject{ExpectedUserID: admin.UserID, Name: "Completion precedence", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	outsider := servicePrincipal(t, database)
	for _, actor := range []model.Principal{admin, outsider} {
		canceled, cancel := context.WithCancel(ctx)
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_grants") }, end: cancel})
		access, err := NewProjects(traced.store).Access(canceled, actor, project.ID)
		cancel()
		assertOperational(t, err)
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(access, model.ProjectAccess{}) {
			t.Fatalf("completion failure masked by actor result: %#v %v", access, err)
		}
	}
	database.Close()
	_, err = projects.Access(ctx, admin, project.ID)
	assertOperational(t, err)
}
