package github

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type failedManageDAO struct {
	*manageDAO
	clockErr, saveErr error
	saved             bool
}

func (d *failedManageDAO) ObservedAt(context.Context) (time.Time, error) {
	return time.Time{}, d.clockErr
}
func (d *failedManageDAO) SaveConfiguration(context.Context, store.GitHubConfigurationWrite) (bool, error) {
	return d.saved, d.saveErr
}

type failedManageScope struct {
	manageScope
	dao store.GitHubWriteDAO
}

func (s failedManageScope) GitHubDAO() store.GitHubWriteDAO { return s.dao }

func TestManageRejectsInvalidOrExhaustedDecisions(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	now := time.Now()
	proof := InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 5, AccountLogin: "provider"}, Repository: githubpr.RepositoryObservation{ID: 9, FullName: "o/r"}}
	for _, tc := range []struct {
		name, action string
		version      int64
		minutes      int32
		app          int64
		mutate       func(*githubpr.Connection)
	}{
		{"zero-version", "disconnect", 0, 0, 7, nil},
		{"invalid-proof", "connect", 1, 0, 0, nil},
		{"invalid-interval", "settings", 1, 0, 7, nil},
		{"unknown-action", "missing", 1, 0, 7, nil},
		{"generation-exhausted", "connect", 1, 0, 7, func(c *githubpr.Connection) { c.Generation = math.MaxInt64 }},
		{"revision-exhausted", "settings", 1, 2, 7, func(c *githubpr.Connection) { c.Revision = math.MaxInt64 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := githubpr.DefaultConnection("p")
			if tc.mutate != nil {
				tc.mutate(&c)
			}
			d := &manageDAO{c: c, now: now}
			s := manageScope{project: &manageProject{role: model.ProjectAdmin, repo: "https://github.com/o/r"}, github: d}
			_, err := Manage(context.Background(), s, p, tc.version, tc.action, tc.minutes, tc.app, s.project.repo, proof)
			if err == nil || d.saved != nil {
				t.Fatalf("accepted invalid request: %v", err)
			}
		})
	}
}
func TestManagePropagatesStorageFailure(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	problem := errors.New("database failure")
	for _, tc := range []struct {
		name     string
		dao      *failedManageDAO
		expected error
	}{
		{"clock", &failedManageDAO{manageDAO: &manageDAO{c: githubpr.DefaultConnection("p")}, clockErr: problem}, problem},
		{"save", &failedManageDAO{manageDAO: &manageDAO{c: githubpr.DefaultConnection("p")}, saveErr: problem}, problem},
		{"conflict", &failedManageDAO{manageDAO: &manageDAO{c: githubpr.DefaultConnection("p")}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := failedManageScope{manageScope: manageScope{project: &manageProject{role: model.ProjectAdmin}}, dao: tc.dao}
			_, err := Manage(context.Background(), s, p, 1, "settings", 2, 0, "", InstallationCandidate{})
			if err == nil || tc.expected != nil && !errors.Is(err, tc.expected) {
				t.Fatalf("error %v", err)
			}
		})
	}
}
func TestSettingsReschedulesAccessCheck(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	checked := now.Add(-time.Minute)
	old := now.Add(4 * time.Minute)
	c := githubpr.DefaultConnection("p")
	c.Enabled = true
	c.SyncEnabled = true
	c.AccessState = "unavailable"
	c.AccessCheckedAt = &checked
	c.NextAccessCheckAt = &old
	d := &manageDAO{c: c, now: now}
	s := manageScope{project: &manageProject{role: model.ProjectAdmin}, github: d}
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	_, err := Manage(context.Background(), s, p, 1, "settings", 10, 0, "", InstallationCandidate{})
	if err != nil || d.saved == nil || !d.saved.NextAccessCheckAt.Equal(checked.Add(10*time.Minute)) {
		t.Fatalf("access schedule %+v %v", d.saved, err)
	}
}
