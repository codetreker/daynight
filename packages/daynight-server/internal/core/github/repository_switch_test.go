package github

import (
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRepositorySwitchDecidesCompleteDisconnectedState(t *testing.T) {
	oldID, legacy, installation := int64(30), int64(7), int64(9)
	oldName, claim := "owner/old", "claim"
	now := time.Now()
	current := githubpr.Connection{ProjectID: "project", Version: 5, Generation: 6, Revision: 7, Enabled: true, SyncEnabled: true, RepositoryID: &oldID, LegacyRepositoryID: &legacy, RepositoryFullName: &oldName, InstallationID: &installation, PollIntervalMinutes: 17, AccessState: "available", ClaimToken: &claim, LastFullSuccessAt: &now}
	target := &store.GitHubRepositoryTarget{RepositoryID: 31, FullName: "owner/new", Private: true}
	got, err := RepositorySwitch(current, target)
	want := store.GitHubRepositorySwitchWrite{ExpectedVersion: 5, ExpectedGeneration: 6, ExpectedRevision: 7, Connection: githubpr.Connection{ProjectID: "project", Version: 6, Generation: 7, Revision: 8, LegacyRepositoryID: &legacy, RepositoryID: &target.RepositoryID, RepositoryFullName: &target.FullName, RepositoryPrivate: &target.Private, PollIntervalMinutes: 17, AccessState: "unknown"}, Source: &githubpr.Repository{RepositoryID: 31, FullName: "owner/new"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got=%+v want=%+v err=%v", got, want, err)
	}
	got, err = RepositorySwitch(current, nil)
	if err != nil || got.Connection.RepositoryID != nil || got.Connection.RepositoryFullName != nil || got.Connection.RepositoryPrivate != nil || got.Source != nil {
		t.Fatalf("unknown target=%+v %v", got, err)
	}
}

func TestRepositorySwitchRejectsExhaustionAndInvalidTarget(t *testing.T) {
	for _, field := range []string{"version", "generation", "revision"} {
		c := githubpr.DefaultConnection("project")
		switch field {
		case "version":
			c.Version = math.MaxInt64
		case "generation":
			c.Generation = math.MaxInt64
		case "revision":
			c.Revision = math.MaxInt64
		}
		_, err := RepositorySwitch(c, nil)
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != "version_exhausted" {
			t.Fatalf("%s: %v", field, err)
		}
	}
	for _, target := range []*store.GitHubRepositoryTarget{{RepositoryID: 0, FullName: "owner/repo"}, {RepositoryID: 4, FullName: " "}} {
		if _, err := RepositorySwitch(githubpr.DefaultConnection("project"), target); err == nil {
			t.Fatalf("invalid target accepted: %+v", target)
		}
	}
}
