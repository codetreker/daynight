package project

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestRegisterRepository(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	input := core.CreateProject{Name: "Repository", RepoURL: "https://GitHub.com/Org/Repo.git", ExpectedUserID: principal.UserID}
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
	ipInput := core.CreateProject{Name: "IPv6", RepoURL: "ssh://git@::1:22/repo", ExpectedUserID: principal.UserID}
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
	if _, err := projects.Create(ctx, principal, input); err != nil {
		t.Fatal(err)
	}
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("ambiguous repository created a Project")
	} else {
		requireFault(t, err, "resource_conflict")
	}
	page, err := projects.List(ctx, principal, model.PageRequest{Limit: 100})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("unexpected Project count: %d %v", len(page.Items), err)
	}
}

func TestRegisterRepositoryValidationAndFailure(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	input := core.CreateProject{Name: "", RepoURL: "https://example.com/repo", ExpectedUserID: principal.UserID}
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("invalid name accepted")
	} else {
		requireFault(t, err, "invalid_input")
	}
	input.Name, input.RepoURL = "Name", "https://example.com/%2f"
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("invalid repository accepted")
	} else {
		requireFault(t, err, "invalid_input")
	}

	// A legacy or corrupt Project address must not be silently skipped during discovery.
	legacy := input
	legacy.RepoURL = "https://example.com/legacy"
	old, err := projects.Create(ctx, principal, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE projects SET repo_url=$1 WHERE id=$2", "https://example.com/%2f", old.ID); err != nil {
		t.Fatal(err)
	}
	input.RepoURL = "https://example.com/other"
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("unidentifiable existing repository silently ignored")
	} else {
		requireFault(t, err, "invalid_input")
	}
	database.Close()
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("database failure ignored")
	}
}

func TestRegisterRepositoryScansAllVisiblePages(t *testing.T) {
	projects, _, _, principal := projectService(t)
	ctx := context.Background()
	input := core.CreateProject{Name: "Repository", RepoURL: "https://example.com/target", ExpectedUserID: principal.UserID}
	first, err := projects.Create(ctx, principal, input)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		other := core.CreateProject{Name: "Other", RepoURL: fmt.Sprintf("https://example.com/other-%d", i), ExpectedUserID: principal.UserID}
		if _, err := projects.Create(ctx, principal, other); err != nil {
			t.Fatal(err)
		}
	}
	if project, created, err := projects.RegisterRepository(ctx, principal, input, false); err != nil || created || project.ID != first.ID {
		t.Fatalf("match across pages: %#v %v %v", project, created, err)
	}
	if _, err := projects.Create(ctx, principal, input); err != nil {
		t.Fatal(err)
	}
	if _, _, err := projects.RegisterRepository(ctx, principal, input, true); err == nil {
		t.Fatal("ambiguity across pages accepted")
	} else {
		requireFault(t, err, "resource_conflict")
	}
}

func TestRegisterRepositoryRejectsOversizedFieldsBeforeMatching(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
	projects := NewProjects(nil)
	prefix := "https://example.com/"
	for _, input := range []core.CreateProject{
		{Name: strings.Repeat("a", 257), RepoURL: "host:repo", ExpectedUserID: principal.UserID},
		{Name: strings.Repeat("😀", 256) + "a", RepoURL: "host:repo", ExpectedUserID: principal.UserID},
		{Name: "Project", RepoURL: prefix + strings.Repeat("r", 4097-len(prefix)), ExpectedUserID: principal.UserID},
	} {
		_, _, err := projects.RegisterRepository(context.Background(), principal, input, true)
		requireFault(t, err, "invalid_input")
	}
}
