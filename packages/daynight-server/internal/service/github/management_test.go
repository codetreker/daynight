package github

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

const mgmtProject = "11111111-1111-4111-8111-111111111111"

var mgmtPrincipal = model.Principal{Kind: model.SessionCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}

type mgmtStore struct {
	snapshot mgmtSnapshot
	write    mgmtWriteScope
	outcome  store.TransactionOutcome
	writes   int
	cause    error
}

func (s *mgmtStore) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(s.snapshot)
}
func (s *mgmtStore) WriteProject(_ context.Context, id string, f func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.writes++
	if id != mgmtProject {
		panic("wrong project")
	}
	err := f(s.write)
	if s.cause != nil {
		err = errors.Join(err, s.cause)
	}
	return store.Completion{Outcome: s.outcome}, err
}

type mgmtSnapshot struct {
	store.SnapshotScope
	projects *mgmtProjects
	github   *mgmtRead
}

func (s mgmtSnapshot) ProjectDAO() store.ProjectReader { return s.projects }
func (s mgmtSnapshot) GitHubDAO() store.GitHubReadDAO  { return s.github }

type mgmtProjects struct {
	store.ProjectReader
	role model.ProjectRole
	repo string
}

func (p *mgmtProjects) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{Role: p.role}, nil
}
func (p *mgmtProjects) Project(context.Context, string) (model.Project, error) {
	return model.Project{ID: mgmtProject, RepoURL: p.repo}, nil
}

type mgmtRead struct {
	store.GitHubReadDAO
	c githubpr.Connection
}

func (d *mgmtRead) Connection(context.Context, string) (githubpr.Connection, error) { return d.c, nil }

type mgmtWriteScope struct {
	store.ProjectWriteScope
	projects *mgmtWriteProject
	github   *mgmtWriteDAO
}

func (s mgmtWriteScope) ProjectDAO() store.ProjectWriteDAO { return s.projects }
func (s mgmtWriteScope) GitHubDAO() store.GitHubWriteDAO   { return s.github }

type mgmtWriteProject struct {
	store.ProjectWriteDAO
	role model.ProjectRole
	repo string
}

func (p *mgmtWriteProject) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	return model.ProjectAccess{Role: p.role}, nil
}
func (p *mgmtWriteProject) Project(context.Context) (model.Project, error) {
	return model.Project{RepoURL: p.repo}, nil
}

type mgmtWriteDAO struct {
	store.GitHubWriteDAO
	c githubpr.Connection
	w *store.GitHubConfigurationWrite
}

func (d *mgmtWriteDAO) Connection(context.Context) (githubpr.Connection, error) { return d.c, nil }
func (d *mgmtWriteDAO) ObservedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil
}
func (d *mgmtWriteDAO) SaveConfiguration(_ context.Context, w store.GitHubConfigurationWrite) (bool, error) {
	d.w = &w
	d.c.Version = w.Version
	d.c.Generation = w.Generation
	d.c.Enabled = w.Enabled
	d.c.SyncEnabled = w.SyncEnabled
	return true, nil
}

type mgmtRemote struct {
	discover, verify, resolve int
	name                      string
	repositoryID              int64
	verifyID                  int64
	err                       error
	id                        int64
}

func (r *mgmtRemote) DiscoverInstallation(_ context.Context, o, n string) (githubpr.InstallationObservation, error) {
	r.discover++
	if o != "owner" || n != r.name {
		panic("wrong target")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.err
}
func (r *mgmtRemote) VerifyAccess(_ context.Context, id int64, o, n string) (githubpr.RepositoryObservation, error) {
	r.verify++
	if id != r.id {
		panic("wrong installation")
	}
	return githubpr.RepositoryObservation{ID: r.verifyID, FullName: "owner/" + r.name, Private: true}, r.err
}
func (r *mgmtRemote) ResolveRepository(_ context.Context, installationID, repositoryID int64) (githubpr.RepositoryObservation, error) {
	r.resolve++
	if installationID != r.id || repositoryID != r.repositoryID {
		return githubpr.RepositoryObservation{}, errors.New("incorrect stable identity")
	}
	return githubpr.RepositoryObservation{ID: r.repositoryID, FullName: "owner/" + r.name, Private: true}, r.err
}
func (r *mgmtRemote) FindInstallationByRepository(_ context.Context, repositoryID int64) (githubpr.InstallationObservation, error) {
	if repositoryID != r.repositoryID {
		return githubpr.InstallationObservation{}, errors.New("incorrect stable identity")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.err
}
func mgmtFixture() (*mgmtStore, *mgmtRemote) {
	c := githubpr.DefaultConnection(mgmtProject)
	repo := "https://github.com/owner/repo.git"
	s := &mgmtStore{snapshot: mgmtSnapshot{projects: &mgmtProjects{role: model.ProjectAdmin, repo: repo}, github: &mgmtRead{c: c}}, write: mgmtWriteScope{projects: &mgmtWriteProject{role: model.ProjectAdmin, repo: repo}, github: &mgmtWriteDAO{c: c}}, outcome: store.TransactionCommitted}
	return s, &mgmtRemote{id: 99, name: "repo", repositoryID: 42, verifyID: 42}
}
func TestManagerConnectProofAndFinalAuthorization(t *testing.T) {
	s, r := mgmtFixture()
	m := NewManager(s, r, 13)
	out, err := m.Connect(context.Background(), mgmtPrincipal, mgmtProject, 1, 99)
	if err != nil || !out.Connection.Enabled || out.Connection.SyncEnabled || s.writes != 1 || r.discover != 1 || r.verify != 1 || s.write.github.w == nil || s.write.github.w.NextPollAt != nil {
		t.Fatalf("connect: %+v %v", out, err)
	}
	for _, kind := range []string{"revoked", "changed", "version", "installation"} {
		t.Run(kind, func(t *testing.T) {
			s, r := mgmtFixture()
			m := NewManager(s, r, 13)
			install := int64(99)
			switch kind {
			case "revoked":
				s.write.projects.role = model.ProjectMemberRole
			case "changed":
				s.write.projects.repo = "https://github.com/other/repo"
			case "version":
				s.write.github.c.Version = 2
			case "installation":
				install = 100
			}
			_, err := m.Connect(context.Background(), mgmtPrincipal, mgmtProject, 1, install)
			if err == nil || s.write.github.w != nil {
				t.Fatalf("accepted %s %v", kind, err)
			}
		})
	}
}
func TestManagerUnknownAndUnconfigured(t *testing.T) {
	s, r := mgmtFixture()
	cause := errors.New("lost commit receipt")
	s.outcome = store.TransactionUnknown
	s.cause = cause
	_, err := NewManager(s, r, 13).Connect(context.Background(), mgmtPrincipal, mgmtProject, 1, 99)
	var mgmt *ManagementError
	if !errors.As(err, &mgmt) || mgmt.Code != "github_write_outcome_unknown" || !errors.Is(err, cause) || s.writes != 1 {
		t.Fatalf("unknown %v", err)
	}
	s, _ = mgmtFixture()
	_, err = NewManager(s, nil, 0).Discover(context.Background(), mgmtPrincipal, mgmtProject)
	if !errors.As(err, &mgmt) || mgmt.Code != "github_not_configured" {
		t.Fatalf("unconfigured %v", err)
	}
}

func TestManagerRefusalsAndRemoteFailures(t *testing.T) {
	for _, tc := range []struct {
		name                string
		prepare             func(*mgmtStore, *mgmtRemote)
		code                string
		writes, remoteCalls int
	}{
		{"member", func(s *mgmtStore, _ *mgmtRemote) { s.snapshot.projects.role = model.ProjectMemberRole }, "forbidden", 0, 0},
		{"snapshot-version", func(s *mgmtStore, _ *mgmtRemote) { s.snapshot.github.c.Version = 2 }, "version_conflict", 0, 0},
		{"other-host", func(s *mgmtStore, _ *mgmtRemote) { s.snapshot.projects.repo = "https://example.com/o/r" }, "github_repository_mismatch", 0, 0},
		{"remote", func(_ *mgmtStore, r *mgmtRemote) { r.err = errors.New("offline") }, "github_unavailable", 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r := mgmtFixture()
			tc.prepare(s, r)
			_, err := NewManager(s, r, 13).Connect(context.Background(), mgmtPrincipal, mgmtProject, 1, 99)
			if err == nil || s.writes != tc.writes || r.discover != tc.remoteCalls {
				t.Fatalf("refusal %v writes %d remote %d", err, s.writes, r.discover)
			}
			var f *model.Fault
			var m *ManagementError
			if errors.As(err, &f) {
				if f.Code != tc.code {
					t.Fatalf("fault %s", f.Code)
				}
			} else if errors.As(err, &m) {
				if m.Code != tc.code {
					t.Fatalf("error %s", m.Code)
				}
			} else {
				t.Fatalf("unexpected %v", err)
			}
		})
	}
}

func TestManagerReconnectRetainedIdentityAfterRename(t *testing.T) {
	for _, sameNameReused := range []bool{false, true} {
		t.Run(fmt.Sprint(sameNameReused), func(t *testing.T) {
			s, r := mgmtFixture()
			repoID := int64(42)
			appID := int64(13)
			installation := int64(99)
			oldName := "owner/repo"
			c := s.snapshot.github.c
			c.RepositoryID = &repoID
			c.AppID = &appID
			c.InstallationID = &installation
			c.RepositoryFullName = &oldName
			c.Enabled = false
			c.Version = 2
			s.snapshot.github.c = c
			s.write.github.c = c
			r.name = "renamed"
			if sameNameReused {
				r.verifyID = 42
			} // The old Project URL is never trusted to identify the retained repository.
			_, err := NewManager(s, r, 13).Connect(context.Background(), mgmtPrincipal, mgmtProject, 2, 99)
			if err != nil || r.resolve != 1 || r.verify != 1 || r.discover != 1 || s.write.github.w == nil || *s.write.github.w.RepositoryID != 42 || *s.write.github.w.RepositoryFullName != "owner/renamed" {
				t.Fatalf("reconnect: %+v %v", s.write.github.w, err)
			}
		})
	}
}
func TestManagerRejectsIdentityChangedAfterResolve(t *testing.T) {
	s, r := mgmtFixture()
	repoID := int64(42)
	s.snapshot.github.c.RepositoryID = &repoID
	s.write.github.c.RepositoryID = &repoID
	r.verifyID = 43
	_, err := NewManager(s, r, 13).Connect(context.Background(), mgmtPrincipal, mgmtProject, 1, 99)
	if err == nil || s.write.github.w != nil {
		t.Fatalf("accepted changed identity: %v", err)
	}
}

func TestDiscoverRetainedNameUnderNewInstallation(t *testing.T) {
	s, r := mgmtFixture()
	repositoryID := int64(42)
	oldInstallation := int64(55)
	name := "owner/renamed"
	s.snapshot.github.c.RepositoryID = &repositoryID
	s.snapshot.github.c.InstallationID = &oldInstallation
	s.snapshot.github.c.RepositoryFullName = &name
	r.name = "renamed"
	candidate, err := NewManager(s, r, 13).Discover(context.Background(), mgmtPrincipal, mgmtProject)
	if err != nil || candidate.Installation.ID != 99 || candidate.Repository.ID != 42 || r.resolve != 0 {
		t.Fatalf("discover: %+v %v", candidate, err)
	}
}

type discoveryFallbackRemote struct {
	*mgmtRemote
	findCalls int
	findErr   error
}

func (r *discoveryFallbackRemote) DiscoverInstallation(_ context.Context, owner, name string) (githubpr.InstallationObservation, error) {
	r.discover++
	if name != "renamed-again" {
		return githubpr.InstallationObservation{}, &remote.Error{Code: "not_found", Status: 404}
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, nil
}
func (r *discoveryFallbackRemote) FindInstallationByRepository(_ context.Context, id int64) (githubpr.InstallationObservation, error) {
	r.findCalls++
	if id != r.repositoryID {
		return githubpr.InstallationObservation{}, errors.New("incorrect repository ID")
	}
	return githubpr.InstallationObservation{ID: r.id, AccountLogin: "another-account"}, r.findErr
}
func (r *discoveryFallbackRemote) ResolveRepository(_ context.Context, installationID, repositoryID int64) (githubpr.RepositoryObservation, error) {
	r.resolve++
	if installationID != r.id {
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "installation_missing", Status: 404}
	}
	if repositoryID != r.repositoryID {
		return githubpr.RepositoryObservation{}, errors.New("incorrect repository ID")
	}
	return githubpr.RepositoryObservation{ID: repositoryID, FullName: "owner/renamed-again", Private: true}, nil
}
func (r *discoveryFallbackRemote) VerifyAccess(_ context.Context, id int64, owner, name string) (githubpr.RepositoryObservation, error) {
	r.verify++
	if id != r.id || owner != "owner" || name != "renamed-again" {
		return githubpr.RepositoryObservation{}, errors.New("incorrect verified identity")
	}
	return githubpr.RepositoryObservation{ID: r.verifyID, FullName: "owner/renamed-again", Private: true}, nil
}
func TestDiscoverScansCurrentAppWhenOldNameAndInstallationAreGone(t *testing.T) {
	for _, tc := range []struct {
		name     string
		scanErr  error
		wantCode string
	}{
		{"found", nil, ""},
		{"timed out", context.DeadlineExceeded, "github_unavailable"},
		{"inaccessible installation", errors.Join(remote.ErrInstallationScanIncomplete, &remote.Error{Code: "not_found", Status: 404}), "github_unavailable"},
		{"rate limited", &remote.Error{Code: "rate_limited", Status: 429}, "github_rate_limited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, base := mgmtFixture()
			r := &discoveryFallbackRemote{mgmtRemote: base, findErr: tc.scanErr}
			repositoryID := int64(42)
			oldInstallation := int64(55)
			oldName := "owner/renamed"
			s.snapshot.github.c.RepositoryID = &repositoryID
			s.snapshot.github.c.InstallationID = &oldInstallation
			s.snapshot.github.c.RepositoryFullName = &oldName
			candidate, err := NewManager(s, r, 13).Discover(context.Background(), mgmtPrincipal, mgmtProject)
			if r.findCalls != 1 {
				t.Fatalf("scan calls %d", r.findCalls)
			}
			if tc.wantCode == "" {
				if err != nil || candidate.Installation.ID != 99 || candidate.Repository.ID != 42 || candidate.Repository.FullName != "owner/renamed-again" || r.verify != 1 {
					t.Fatalf("candidate %+v err %v", candidate, err)
				}
				return
			}
			var failure *ManagementError
			if !errors.As(err, &failure) || failure.Code != tc.wantCode {
				t.Fatalf("failure %v", err)
			}
		})
	}
}
