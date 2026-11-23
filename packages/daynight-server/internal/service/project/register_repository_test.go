package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRegisterRepositoryValidationAndFailure(t *testing.T) {
	team := resolveTeam
	for _, test := range []struct {
		name  string
		input core.CreateProject
	}{
		{"empty name", core.CreateProject{RepoURL: "https://example.com/repo", TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}},
		{"encoded slash", core.CreateProject{Name: "Name", RepoURL: "https://example.com/%2f", TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}},
		{"missing target team", core.CreateProject{Name: "Name", RepoURL: "https://example.com/repo", ExpectedUserID: resolvePrincipal.UserID}},
	} {
		t.Run(test.name, func(t *testing.T) {
			project, created, err := NewProjects(projectValidationStore{}).RegisterRepository(t.Context(), resolvePrincipal, test.input, true)
			requireFault(t, err, "invalid_input")
			if !reflect.DeepEqual(project, model.Project{}) || created {
				t.Fatalf("validation returned a project: %#v created=%v", project, created)
			}
		})
	}

	input := core.CreateProject{Name: "Name", RepoURL: "https://example.com/other", TeamID: &team, ExpectedUserID: resolvePrincipal.UserID}
	t.Run("snapshot begin failure", func(t *testing.T) {
		begin := &store.Error{Phase: "begin snapshot", Cause: errors.New("closed pool"), DatabaseFailure: true}
		db := newCompletionProjectReadPlan(t, t.Context(), nil)
		db.begin = begin
		project, created, err := NewProjects(db).RegisterRepository(t.Context(), resolvePrincipal, input, true)
		assertProjectStoreFailure(t, project, err, begin)
		if created {
			t.Fatal("snapshot failure reported a created Project")
		}
	})
}

func TestRegisterRepositoryRejectsOversizedFieldsBeforeMatching(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
	projects := NewProjects(nil)
	prefix := "https://example.com/"
	team := resolveTeam
	for _, input := range []core.CreateProject{
		{Name: strings.Repeat("a", 257), RepoURL: "host:repo", TeamID: &team, ExpectedUserID: principal.UserID},
		{Name: strings.Repeat("😀", 256) + "a", RepoURL: "host:repo", TeamID: &team, ExpectedUserID: principal.UserID},
		{Name: "Project", RepoURL: prefix + strings.Repeat("r", 4097-len(prefix)), TeamID: &team, ExpectedUserID: principal.UserID},
	} {
		_, _, err := projects.RegisterRepository(context.Background(), principal, input, true)
		requireFault(t, err, "invalid_input")
	}
}
