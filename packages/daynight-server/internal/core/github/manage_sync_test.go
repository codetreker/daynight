package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestManageSyncDecisions(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	app, installation, repo := int64(7), int64(5), int64(9)
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	connected := githubpr.DefaultConnection("p")
	connected.Enabled, connected.AppID, connected.InstallationID, connected.RepositoryID, connected.AccessState = true, &app, &installation, &repo, "available"
	notBefore := now.Add(time.Hour)
	connected.NotBefore = &notBefore
	unavailable := connected
	unavailable.AccessState = "unavailable"
	missingBinding := connected
	missingBinding.InstallationID = nil
	for _, tc := range []struct {
		name                string
		conn                githubpr.Connection
		enabled, available  bool
		version, currentApp int64
		role                model.ProjectRole
		code                string
		write               bool
	}{
		{"enable", connected, true, true, 1, app, model.ProjectAdmin, "", true},
		{"service unavailable", connected, true, false, 1, app, model.ProjectAdmin, "github_not_configured", false},
		{"unconnected", githubpr.DefaultConnection("p"), true, true, 1, app, model.ProjectAdmin, "github_not_connected", false},
		{"different app", connected, true, true, 1, app + 1, model.ProjectAdmin, "github_connection_unavailable", false},
		{"unavailable access", unavailable, true, true, 1, app, model.ProjectAdmin, "github_connection_unavailable", false},
		{"missing binding", missingBinding, true, true, 1, app, model.ProjectAdmin, "github_connection_unavailable", false},
		{"stale version", connected, false, false, 2, app, model.ProjectAdmin, "version_conflict", false},
		{"same false without service", connected, false, false, 1, app, model.ProjectAdmin, "", false},
		{"member cannot use no-op", connected, false, false, 1, app, model.ProjectMemberRole, "forbidden", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &manageDAO{c: tc.conn, now: now}
			s := manageScope{project: &manageProject{role: tc.role}, github: d}
			_, err := ManageSync(context.Background(), s, p, tc.version, tc.enabled, tc.available, tc.currentApp)
			if tc.code == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.code != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.code {
					t.Fatalf("expected %s, got %v", tc.code, err)
				}
			}
			if (d.saved != nil) != tc.write {
				t.Fatalf("write = %+v", d.saved)
			}
			if tc.write && (!d.saved.SyncEnabled || d.saved.Generation != connected.Generation+1 || d.saved.Version != 2 || d.saved.Revision != connected.Revision+1 || d.saved.NextPollAt == nil || !d.saved.NextPollAt.Equal(now) || d.c.NotBefore != &notBefore) {
				t.Fatalf("enable = %+v", d.saved)
			}
		})
	}
}

func TestManageReconnectWithSyncDisabled(t *testing.T) {
	now := time.Now().UTC()
	app, installation, repo := int64(7), int64(5), int64(9)
	c := githubpr.DefaultConnection("p")
	c.Enabled, c.AppID, c.InstallationID, c.RepositoryID, c.AccessState = true, &app, &installation, &repo, "unavailable"
	d := &manageDAO{c: c, now: now}
	s := manageScope{project: &manageProject{role: model.ProjectAdmin, repo: "https://github.com/o/r"}, github: d}
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	proof := InstallationCandidate{Installation: githubpr.InstallationObservation{ID: installation, AccountLogin: "owner"}, Repository: githubpr.RepositoryObservation{ID: repo, FullName: "o/r"}}
	_, err := Manage(context.Background(), s, p, 1, "connect", 0, app, s.project.repo, proof)
	if err != nil || d.saved == nil || d.saved.SyncEnabled || d.saved.NextPollAt != nil || d.saved.AccessState != "available" {
		t.Fatalf("reconnect: %+v %v", d.saved, err)
	}
}

func TestManageSyncDisableAndClosedSettings(t *testing.T) {
	now := time.Now().UTC()
	app, installation, repo := int64(7), int64(5), int64(9)
	c := githubpr.DefaultConnection("p")
	c.Enabled, c.SyncEnabled, c.AppID, c.InstallationID, c.RepositoryID, c.AccessState = true, true, &app, &installation, &repo, "available"
	c.NextPollAt, c.NextAccessCheckAt = &now, &now
	d := &manageDAO{c: c, now: now}
	s := manageScope{project: &manageProject{role: model.ProjectAdmin}, github: d}
	p := model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	_, err := ManageSync(context.Background(), s, p, 1, false, false, 0)
	if err != nil || d.saved == nil || d.saved.SyncEnabled || !d.saved.Enabled || d.saved.Generation != c.Generation+1 || d.saved.NextPollAt != nil || d.saved.NextAccessCheckAt != nil {
		t.Fatalf("disable: %+v %v", d.saved, err)
	}
	d.c.NextPollAt, d.c.NextAccessCheckAt = nil, nil
	d.saved = nil
	_, err = Manage(context.Background(), s, p, 2, "settings", 10, 0, "", InstallationCandidate{})
	if err != nil || d.saved == nil || d.saved.SyncEnabled || d.saved.NextPollAt != nil || d.saved.NextAccessCheckAt != nil || d.saved.Generation != c.Generation+1 {
		t.Fatalf("closed settings: %+v %v", d.saved, err)
	}
}
