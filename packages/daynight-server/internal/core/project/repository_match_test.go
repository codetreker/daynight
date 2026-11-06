package project

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRepositoryMatchSelection(t *testing.T) {
	check := func(err error, code string) {
		t.Helper()
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
	if _, err := NewRepositoryMatch("invalid"); err == nil {
		t.Fatal("invalid target accepted")
	}
	match, err := NewRepositoryMatch("https://GitHub.com/Org/Repo.git")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := match.Select(false); err == nil {
		t.Fatal("unconfirmed creation accepted")
	} else {
		check(err, "invalid_input")
	}
	if _, create, err := match.Select(true); err != nil || !create {
		t.Fatalf("confirmed creation: %v %v", create, err)
	}
	if err := match.Add(model.Project{ID: "other", RepoURL: "https://github.com/org/Repo"}); err != nil {
		t.Fatal(err)
	}
	if err := match.Add(model.Project{ID: "match", RepoURL: "git@github.com:Org/Repo"}); err != nil {
		t.Fatal(err)
	}
	if project, create, err := match.Select(false); err != nil || create || project.ID != "match" {
		t.Fatalf("reuse: %#v %v %v", project, create, err)
	}
	if err := match.Add(model.Project{ID: "second", RepoURL: "ssh://git@github.com:22/Org/Repo.git"}); err == nil {
		t.Fatal("ambiguous match accepted")
	} else {
		check(err, "resource_conflict")
	}
	if err := match.Add(model.Project{RepoURL: "invalid"}); err == nil {
		t.Fatal("invalid candidate ignored")
	} else {
		check(err, "invalid_input")
	}
}
