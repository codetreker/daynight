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

type projectAppRuleDAO struct {
	f                                              store.GitHubProjectAppFacts
	a                                              store.GitHubProjectApp
	saved                                          *store.GitHubProjectAppWrite
	impacts                                        []string
	factsErr, appErr, clockErr, saveErr, impactErr error
	conflict                                       bool
}

func (d *projectAppRuleDAO) Facts(context.Context, model.Principal) (store.GitHubProjectAppFacts, error) {
	return d.f, d.factsErr
}
func (d *projectAppRuleDAO) App(context.Context, string, string, string) (store.GitHubProjectApp, error) {
	return d.a, d.appErr
}
func (d *projectAppRuleDAO) ObservedAt(context.Context) (time.Time, error) {
	return time.Unix(100, 0), d.clockErr
}
func (d *projectAppRuleDAO) Save(_ context.Context, w store.GitHubProjectAppWrite) (bool, error) {
	d.saved = &w
	if d.saveErr != nil || d.conflict {
		return false, d.saveErr
	}
	d.f.AppResourceID = w.AppResourceID
	d.f.GrantID = w.GrantID
	d.f.CredentialVersion = w.CredentialVersion
	c := &d.f.Connection
	x := w.Configuration
	c.Version = x.Version
	c.Generation = x.Generation
	c.Revision = x.Revision
	c.Enabled = x.Enabled
	c.SyncEnabled = x.SyncEnabled
	c.AppID = x.AppID
	c.InstallationID = x.InstallationID
	c.RepositoryID = x.RepositoryID
	c.AccessState = x.AccessState
	c.PollIntervalMinutes = x.PollIntervalMinutes
	return true, nil
}
func (d *projectAppRuleDAO) AdvanceImpact(_ context.Context, id string) error {
	d.impacts = append(d.impacts, id)
	return d.impactErr
}
func appRuleFixture() (*projectAppRuleDAO, model.Principal, ProjectAppConnect, InstallationCandidate) {
	role := model.ProjectAdmin
	d := &projectAppRuleDAO{f: store.GitHubProjectAppFacts{Project: model.Project{RepoURL: "https://github.com/o/r", Ownership: model.ProjectOwnership{TeamID: "team", Version: 1}}, Access: model.ProjectAccess{Role: role, TeamRole: &role}, Connection: githubpr.DefaultConnection("project")}, a: store.GitHubProjectApp{ID: "11111111-1111-4111-8111-111111111111", Name: "Safe App", GitHubSlug: "safe", GitHubAppID: 9, Version: 1, CredentialVersion: 1}}
	p := model.Principal{Kind: model.SessionCredential, UserID: "22222222-2222-4222-8222-222222222222", CredentialID: "33333333-3333-4333-8333-333333333333"}
	in := ProjectAppConnect{ProjectAppSelection: ProjectAppSelection{AppResourceID: d.a.ID, GrantID: "44444444-4444-4444-8444-444444444444", AppVersion: 1, OwnershipVersion: 1}, Version: 1, InstallationID: 7}
	proof := InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 7, AccountLogin: "o"}, Repository: githubpr.RepositoryObservation{ID: 8, FullName: "o/r"}}
	return d, p, in, proof
}
func appRuleFaultCode(err error) string {
	var f *model.Fault
	if errors.As(err, &f) {
		return f.Code
	}
	if err != nil {
		return "internal"
	}
	return ""
}

func TestProjectAppRulesPreserveIntentAndStableRepository(t *testing.T) {
	d, p, in, proof := appRuleFixture()
	ctx := t.Context()
	manage := func(action string, minutes int32, enabled bool) (ProjectAppStatus, error) {
		return ManageProjectApp(ctx, d, p, action, in, minutes, enabled, d.f.Project.RepoURL, proof)
	}
	out, err := manage("connect", 0, false)
	if err != nil || !out.Connection.Enabled || out.Connection.SyncEnabled || out.App == nil || len(d.impacts) != 1 || !d.saved.ClearWork {
		t.Fatalf("connect: %+v %+v %v", out, d, err)
	}
	in.Version = out.Connection.Version
	d.saved = nil
	if _, err = manage("connect", 0, false); err != nil || d.saved != nil {
		t.Fatalf("same binding: %v", err)
	}
	proof.Repository.ID = 90
	if _, err = manage("connect", 0, false); appRuleFaultCode(err) != "github_repository_mismatch" {
		t.Fatalf("repository replacement: %v", err)
	}
	proof.Repository.ID = 8
	out, err = manage("sync", 0, true)
	if err != nil || !out.Connection.SyncEnabled || d.saved.Configuration.NextPollAt == nil {
		t.Fatalf("enable: %+v %v", out, err)
	}
	in.Version = out.Connection.Version
	d.saved = nil
	if _, err = manage("sync", 0, true); err != nil || d.saved != nil {
		t.Fatalf("same intent: %v", err)
	}
	d.f.Connection.AccessState = "unavailable"
	out, err = manage("connect", 0, false)
	if err != nil || !out.Connection.SyncEnabled || d.saved.Configuration.NextPollAt == nil || len(d.impacts) != 1 {
		t.Fatalf("reconnect: %+v %v", out, err)
	}
	in.Version = out.Connection.Version
	out, err = manage("disconnect", 0, false)
	if err != nil || out.Connection.Enabled || out.Connection.SyncEnabled || out.App != nil || out.Connection.RepositoryID == nil || len(d.impacts) != 2 {
		t.Fatalf("disconnect: %+v %v", out, err)
	}
	in.Version = out.Connection.Version
	d.saved = nil
	if _, err = manage("disconnect", 0, false); err != nil || d.saved != nil {
		t.Fatalf("repeat disconnect: %v", err)
	}
	d.f.Connection.SyncEnabled = true
	if out, err = manage("disconnect", 0, false); err != nil || out.Connection.SyncEnabled {
		t.Fatalf("clear retained intent: %+v %v", out, err)
	}
}

func TestProjectAppRuleRejections(t *testing.T) {
	cause := errors.New("store failure")
	for _, tc := range []struct {
		name, action, code string
		change             func(*projectAppRuleDAO, *ProjectAppConnect, *InstallationCandidate)
	}{
		{"project admin only", "connect", "forbidden", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.f.Access.TeamRole = nil }},
		{"stale ownership", "disconnect", "version_conflict", func(_ *projectAppRuleDAO, in *ProjectAppConnect, _ *InstallationCandidate) { in.OwnershipVersion++ }},
		{"member settings", "settings", "forbidden", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) {
			d.f.Access.Role = model.ProjectMemberRole
		}},
		{"bad action", "bad", "invalid_input", func(*projectAppRuleDAO, *ProjectAppConnect, *InstallationCandidate) {}},
		{"bad version", "disconnect", "invalid_input", func(_ *projectAppRuleDAO, in *ProjectAppConnect, _ *InstallationCandidate) { in.Version = 0 }},
		{"stale config", "disconnect", "version_conflict", func(_ *projectAppRuleDAO, in *ProjectAppConnect, _ *InstallationCandidate) { in.Version++ }},
		{"revoked grant", "connect", "github_grant_changed", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) {
			d.appErr = model.ErrNotFound
		}},
		{"app read error", "connect", "internal", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.appErr = cause }},
		{"stale app", "connect", "version_conflict", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.a.Version++ }},
		{"changed repo URL", "connect", "github_repository_mismatch", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) {
			d.f.Project.RepoURL = "changed"
		}},
		{"bad proof", "connect", "invalid_input", func(_ *projectAppRuleDAO, _ *ProjectAppConnect, c *InstallationCandidate) { c.Installation.ID++ }},
		{"clock", "connect", "internal", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.clockErr = cause }},
		{"save", "connect", "internal", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.saveErr = cause }},
		{"save conflict", "connect", "version_conflict", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.conflict = true }},
		{"impact", "connect", "internal", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.impactErr = cause }},
		{"exhaustion", "connect", "version_exhausted", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) {
			d.f.Connection.Generation = math.MaxInt64
		}},
		{"not connected", "sync", "github_not_connected", func(*projectAppRuleDAO, *ProjectAppConnect, *InstallationCandidate) {}},
		{"facts", "connect", "internal", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) { d.factsErr = cause }},
		{"no project access", "connect", "not_found", func(d *projectAppRuleDAO, _ *ProjectAppConnect, _ *InstallationCandidate) {
			d.factsErr = model.ErrNotFound
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, p, in, proof := appRuleFixture()
			repo := d.f.Project.RepoURL
			tc.change(d, &in, &proof)
			_, err := ManageProjectApp(t.Context(), d, p, tc.action, in, 10, true, repo, proof)
			if appRuleFaultCode(err) != tc.code {
				t.Fatalf("got %s: %v", appRuleFaultCode(err), err)
			}
		})
	}
}

func TestProjectAppValidationAndStatusIntegrity(t *testing.T) {
	d, _, in, _ := appRuleFixture()
	if err := ValidateProjectAppSelection(in.ProjectAppSelection); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*ProjectAppSelection){func(s *ProjectAppSelection) { s.AppResourceID = "bad" }, func(s *ProjectAppSelection) { s.GrantID = "bad" }, func(s *ProjectAppSelection) { s.AppVersion = 0 }} {
		bad := in.ProjectAppSelection
		change(&bad)
		if err := ValidateProjectAppSelection(bad); err == nil {
			t.Fatal("bad selection accepted")
		}
	}
	if _, err := ReadProjectAppFacts(t.Context(), d, model.Principal{}); err == nil {
		t.Fatal("anonymous read")
	}
	for _, change := range []func(*projectAppRuleDAO){
		func(d *projectAppRuleDAO) { d.f.Connection.Enabled = true },
		func(d *projectAppRuleDAO) { d.f.AppResourceID = &d.a.ID },
		func(d *projectAppRuleDAO) {
			d.f.AppResourceID = &d.a.ID
			d.f.GrantID = &in.GrantID
			d.f.CredentialVersion = &d.a.CredentialVersion
			d.appErr = errors.New("missing")
		},
		func(d *projectAppRuleDAO) {
			d.f.AppResourceID = &d.a.ID
			d.f.GrantID = &in.GrantID
			d.f.CredentialVersion = &d.a.CredentialVersion
		},
	} {
		d, _, _, _ = appRuleFixture()
		change(d)
		if _, err := ProjectAppStatusFrom(t.Context(), d, d.f); err == nil {
			t.Fatal("corrupt connection accepted")
		}
	}
	d, _, _, _ = appRuleFixture()
	d.f.Access.TeamRole = nil
	if status, err := ProjectAppStatusFrom(t.Context(), d, d.f); err != nil || status.CanManageConnection {
		t.Fatalf("ordinary reader status %+v %v", status, err)
	}
}

func TestProjectAppSettingsAndSyncGuards(t *testing.T) {
	d, p, in, proof := appRuleFixture()
	ctx := t.Context()
	if _, err := ManageProjectApp(ctx, d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof); err != nil {
		t.Fatal(err)
	}
	in.Version = d.f.Connection.Version
	d.f.Access.TeamRole = nil
	if _, err := ManageProjectApp(ctx, d, p, "settings", in, 9, false, "", proof); err != nil || d.saved.ClearWork {
		t.Fatalf("direct admin settings: %v", err)
	}
	in.Version = d.f.Connection.Version
	d.saved = nil
	if _, err := ManageProjectApp(ctx, d, p, "settings", in, 9, false, "", proof); err != nil || d.saved != nil {
		t.Fatalf("settings no-op %v", err)
	}
	if _, err := ManageProjectApp(ctx, d, p, "settings", in, 0, false, "", proof); appRuleFaultCode(err) != "invalid_input" {
		t.Fatalf("interval: %v", err)
	}
	d.f.Connection.AccessState = "unavailable"
	if _, err := ManageProjectApp(ctx, d, p, "sync", in, 0, true, "", proof); appRuleFaultCode(err) != "github_connection_unavailable" {
		t.Fatalf("unavailable: %v", err)
	}
	d.f.Connection.AccessState = "available"
	d.f.AppResourceID = nil
	if _, err := ManageProjectApp(ctx, d, p, "sync", in, 0, true, "", proof); err == nil {
		t.Fatal("incomplete identity enabled")
	}
}

func TestProjectAppScheduleAndReplacement(t *testing.T) {
	d, p, in, proof := appRuleFixture()
	ctx := t.Context()
	if _, err := ManageProjectApp(ctx, d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof); err != nil {
		t.Fatal(err)
	}
	in.Version = d.f.Connection.Version
	d.f.Connection.SyncEnabled = true
	last := time.Unix(50, 0)
	deadline := time.Unix(999, 0)
	generation := d.f.Connection.Generation
	d.f.Connection.LastFullSuccessAt = &last
	d.f.Connection.LastFullGeneration = &generation
	d.f.Connection.NextPollAt = &deadline
	d.f.Connection.AccessState = "unavailable"
	d.f.Connection.AccessCheckedAt = &last
	d.f.Connection.NextAccessCheckAt = &deadline
	if _, err := ManageProjectApp(ctx, d, p, "settings", in, 10, false, "", proof); err != nil {
		t.Fatal(err)
	}
	if d.saved.Configuration.NextPollAt == nil || !d.saved.Configuration.NextPollAt.Equal(IntervalAfter(last, 10)) || d.saved.Configuration.NextAccessCheckAt == nil || !d.saved.Configuration.NextAccessCheckAt.Equal(IntervalAfter(last, 10)) {
		t.Fatalf("schedule: %+v", d.saved)
	}
	in.Version = d.f.Connection.Version
	d.a.ID = "55555555-5555-4555-8555-555555555555"
	in.AppResourceID = d.a.ID
	if _, err := ManageProjectApp(ctx, d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof); err != nil {
		t.Fatal(err)
	}
	if len(d.impacts) != 3 || d.impacts[1] == d.impacts[2] || d.saved.Configuration.NextPollAt == nil {
		t.Fatalf("replacement impacts %+v", d.impacts)
	}
	in.Version = d.f.Connection.Version
	d.impactErr = errors.New("old impact failed")
	in.InstallationID++
	proof.Installation.ID = in.InstallationID
	if _, err := ManageProjectApp(ctx, d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof); !errors.Is(err, d.impactErr) {
		t.Fatalf("old impact error %v", err)
	}
}
