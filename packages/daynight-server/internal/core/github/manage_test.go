package github

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type manageScope struct {
	store.ProjectWriteScope
	project *manageProject
	github  *manageDAO
}

func (s manageScope) ProjectDAO() store.ProjectWriteDAO { return s.project }
func (s manageScope) GitHubDAO() store.GitHubWriteDAO   { return s.github }

type manageProject struct {
	store.ProjectWriteDAO
	role model.ProjectRole
	repo string
}

func (p *manageProject) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	return model.ProjectAccess{Role: p.role}, nil
}
func (p *manageProject) Project(context.Context) (model.Project, error) {
	return model.Project{RepoURL: p.repo}, nil
}

type manageDAO struct {
	store.GitHubWriteDAO
	c     githubpr.Connection
	saved *store.GitHubConfigurationWrite
	now   time.Time
}

func (d *manageDAO) Connection(context.Context) (githubpr.Connection, error) { return d.c, nil }
func (d *manageDAO) ObservedAt(context.Context) (time.Time, error)           { return d.now, nil }
func (d *manageDAO) SaveConfiguration(_ context.Context, w store.GitHubConfigurationWrite) (bool, error) {
	d.saved = &w
	d.c.Version = w.Version
	d.c.Generation = w.Generation
	d.c.Revision = w.Revision
	d.c.Enabled = w.Enabled
	d.c.SyncEnabled = w.SyncEnabled
	d.c.AccessState = w.AccessState
	d.c.AccessReason = w.AccessReason
	d.c.AppID = w.AppID
	d.c.InstallationID = w.InstallationID
	d.c.RepositoryID = w.RepositoryID
	return true, nil
}

func TestManageConfigurationTransitions(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	dao := &manageDAO{c: githubpr.DefaultConnection("project"), now: now}
	scope := manageScope{project: &manageProject{role: model.ProjectAdmin, repo: "https://github.com/o/r"}, github: dao}
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	proof := InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 5, AccountLogin: "provider"}, Repository: githubpr.RepositoryObservation{ID: 9, FullName: "o/r", Private: true}}
	c, err := Manage(ctx, scope, principal, 1, "connect", 0, 7, scope.project.repo, proof)
	if err != nil || c.Version != 2 || c.Generation != 1 || !c.Enabled || c.SyncEnabled || dao.saved.NextPollAt != nil {
		t.Fatalf("connect: %+v %+v %v", c, dao.saved, err)
	}
	dao.saved = nil
	_, err = Manage(ctx, scope, principal, 2, "connect", 0, 7, scope.project.repo, proof)
	if err != nil || dao.saved != nil {
		t.Fatalf("same binding: %v", err)
	}
	proof.Repository.ID = 10
	_, err = Manage(ctx, scope, principal, 2, "connect", 0, 7, scope.project.repo, proof)
	if err == nil || dao.saved != nil {
		t.Fatal("accepted different repository")
	}
	_, err = Manage(ctx, scope, principal, 1, "disconnect", 0, 7, "", proof)
	if err == nil || dao.saved != nil {
		t.Fatal("accepted stale version")
	}
	_, err = Manage(ctx, scope, principal, 2, "disconnect", 0, 7, "", proof)
	if err != nil || dao.saved.Generation != 2 || dao.saved.Enabled || dao.saved.RepositoryID == nil || *dao.saved.RepositoryID != 9 {
		t.Fatalf("disconnect: %+v %v", dao.saved, err)
	}
	dao.saved = nil
	_, err = Manage(ctx, scope, principal, 3, "disconnect", 0, 7, "", proof)
	if err != nil || dao.saved != nil {
		t.Fatal("disconnected no-op")
	}
	scope.project.role = model.ProjectMemberRole
	_, err = Manage(ctx, scope, principal, 3, "settings", 2, 7, "", proof)
	if err == nil || dao.saved != nil {
		t.Fatal("member managed connection")
	}
}
func TestManageSettingsSchedule(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	for _, tc := range []struct {
		name                   string
		minutes                int32
		first, failed, running bool
		want                   time.Time
	}{
		{"shorter", 2, false, false, false, now.Add(2 * time.Minute)},
		{"longer", 20, false, false, false, now.Add(20 * time.Minute)},
		{"first stays immediate", 20, true, false, false, now},
		{"failed retry retained", 20, false, true, false, now.Add(30 * time.Second)},
		{"running retained", 20, false, false, true, now.Add(10 * time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := githubpr.DefaultConnection("p")
			c.Enabled = true
			c.SyncEnabled = true
			c.Generation = 2
			generation := c.Generation
			c.LastFullGeneration = &generation
			c.LastFullSuccessAt = &now
			planned := now.Add(10 * time.Minute)
			if tc.first {
				c.LastFullGeneration = nil
				planned = now
			}
			if tc.failed {
				code := "github_unavailable"
				c.PollErrorCode = &code
				planned = now.Add(30 * time.Second)
			}
			if tc.running {
				kind := WorkPoll
				c.ClaimKind = &kind
			}
			c.NextPollAt = &planned
			dao := &manageDAO{c: c, now: now}
			scope := manageScope{project: &manageProject{role: model.ProjectAdmin}, github: dao}
			_, err := Manage(context.Background(), scope, p, 1, "settings", tc.minutes, 0, "", InstallationCandidate{})
			if err != nil || dao.saved == nil || dao.saved.Generation != 2 || dao.saved.NextPollAt == nil || !dao.saved.NextPollAt.Equal(tc.want) {
				t.Fatalf("schedule: %+v %v", dao.saved, err)
			}
		})
	}
}
func TestProjectRepositoryAddress(t *testing.T) {
	for _, s := range []string{"https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git"} {
		o, r, e := ProjectRepository(s)
		if e != nil || o != "o" || r != "r" {
			t.Fatalf("%s %s %s %v", s, o, r, e)
		}
	}
	for _, s := range []string{"https://example.com/o/r", "https://github.com/o/r/other"} {
		if _, _, e := ProjectRepository(s); e == nil {
			t.Fatalf("accepted %s", s)
		}
	}
}

func TestManageReconnectUnavailableBinding(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, reason := range []string{"app_changed", "installation_missing", "permission_denied"} {
		t.Run(reason, func(t *testing.T) {
			app, installation, repo := int64(7), int64(5), int64(9)
			c := githubpr.DefaultConnection("project")
			c.Version = 3
			c.Generation = 2
			c.Revision = 4
			c.Enabled = true
			c.SyncEnabled = true
			c.AppID = &app
			c.InstallationID = &installation
			c.RepositoryID = &repo
			c.AccessState = "unavailable"
			c.AccessReason = &reason
			dao := &manageDAO{c: c, now: now}
			scope := manageScope{project: &manageProject{role: model.ProjectAdmin, repo: "https://github.com/o/r"}, github: dao}
			p := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
			proof := InstallationCandidate{Installation: githubpr.InstallationObservation{ID: installation, AccountLogin: "provider"}, Repository: githubpr.RepositoryObservation{ID: repo, FullName: "o/r"}}
			_, err := Manage(context.Background(), scope, p, 3, "connect", 0, app, scope.project.repo, proof)
			if err != nil || dao.saved == nil || dao.saved.Generation != 3 || dao.saved.Version != 4 || dao.saved.AccessState != "available" || dao.saved.AccessReason != nil || dao.saved.NextPollAt == nil || !dao.saved.NextPollAt.Equal(now) {
				t.Fatalf("reconnect: %+v %v", dao.saved, err)
			}
		})
	}
}
