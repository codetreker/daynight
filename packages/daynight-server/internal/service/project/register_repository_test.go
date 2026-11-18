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
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func TestRegisterRepository(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	team := newTestTeam(t, teamservice.NewTeams(database), principal, "Repository owner")
	input := core.CreateProject{Name: "Repository", RepoURL: "https://GitHub.com/Org/Repo.git", TeamID: &team.ID, ExpectedUserID: principal.UserID}
	if _, _, err := projects.RegisterRepository(ctx, principal, input, false); err == nil {
		t.Fatal("creation without confirmation succeeded")
	} else {
		requireFault(t, err, "invalid_input")
	}
	created, didCreate, err := projects.RegisterRepository(ctx, principal, input, true)
	if err != nil || !didCreate {
		t.Fatalf("confirmed create: %#v %v %v", created, didCreate, err)
	}
	input.RepoURL = "git@github.com:Org/Repo.git"
	reused, didCreate, err := projects.RegisterRepository(ctx, principal, input, false)
	if err != nil || didCreate || reused.ID != created.ID {
		t.Fatalf("reuse: %#v %v %v", reused, didCreate, err)
	}

	// The same repository in another user's Personal Team is not visible.
	other := servicePrincipal(t, database)
	otherInput := core.CreateProject{Name: "Private", RepoURL: input.RepoURL, ExpectedUserID: other.UserID}
	if _, err := projects.Create(ctx, other, otherInput); err != nil {
		t.Fatal(err)
	}
	reused, didCreate, err = projects.RegisterRepository(ctx, principal, input, false)
	if err != nil || didCreate || reused.ID != created.ID {
		t.Fatalf("private project affected match: %#v %v %v", reused, didCreate, err)
	}

	// Special paths and nondefault ports must not be merged with ordinary forms.
	for _, repo := range []string{"git@github.com:./Org/Repo.git", "ssh://git@github.com:2222/Org/Repo.git", "https://github.com/org/Repo.git"} {
		input.RepoURL = repo
		if _, _, err := projects.RegisterRepository(ctx, principal, input, false); err == nil {
			t.Fatalf("%q reused an unrelated Project", repo)
		} else {
			requireFault(t, err, "invalid_input")
		}
	}
	// CLI-valid unbracketed SSH IPv6 is accepted for creation as well as lookup.
	ipInput := core.CreateProject{Name: "IPv6", RepoURL: "ssh://git@::1:22/repo", TeamID: &team.ID, ExpectedUserID: principal.UserID}
	ipProject, didCreate, err := projects.RegisterRepository(ctx, principal, ipInput, true)
	if err != nil || !didCreate {
		t.Fatalf("IPv6 create: %#v %v %v", ipProject, didCreate, err)
	}
	ipInput.RepoURL = "https://[::1]/repo"
	ipReused, didCreate, err := projects.RegisterRepository(ctx, principal, ipInput, false)
	if err != nil || didCreate || ipReused.ID != ipProject.ID {
		t.Fatalf("IPv6 reuse: %#v %v %v", ipReused, didCreate, err)
	}
	input.RepoURL = "ssh://git@github.com:22/Org/Repo.git"
	otherTeam := newTestTeam(t, teamservice.NewTeams(database), principal, "Another visible repository owner")
	duplicate := input
	duplicate.TeamID = &otherTeam.ID
	otherProject, didCreate, err := projects.RegisterRepository(ctx, principal, duplicate, true)
	if err != nil || !didCreate || otherProject.ID == created.ID {
		t.Fatalf("create in other Team: %#v %v %v", otherProject, didCreate, err)
	}
	reused, didCreate, err = projects.RegisterRepository(ctx, principal, input, false)
	if err != nil || didCreate || reused.ID != created.ID {
		t.Fatalf("other Team changed target match: %#v %v %v", reused, didCreate, err)
	}
	reused, didCreate, err = projects.RegisterRepository(ctx, principal, duplicate, false)
	if err != nil || didCreate || reused.ID != otherProject.ID {
		t.Fatalf("other Team match: %#v %v %v", reused, didCreate, err)
	}
	page, err := projects.List(ctx, principal, model.PageRequest{Limit: 100})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("unexpected Project count: %d %v", len(page.Items), err)
	}
}

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
