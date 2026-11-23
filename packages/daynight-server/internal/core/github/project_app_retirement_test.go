package github

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestProjectAppIntervalRetainsScheduledWork(t *testing.T) {
	now := time.Unix(100, 0)
	for _, tc := range []struct {
		name                    string
		minutes                 int32
		initial, failed, active bool
		want                    time.Time
	}{
		{"shorter interval", 2, false, false, false, now.Add(2 * time.Minute)},
		{"longer interval", 20, false, false, false, now.Add(20 * time.Minute)},
		{"initial reconciliation", 20, true, false, false, now},
		{"failed retry", 20, false, true, false, now.Add(30 * time.Second)},
		{"running poll", 20, false, false, true, now.Add(10 * time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, p, in, proof := appRuleFixture()
			connected, err := ManageProjectApp(t.Context(), d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof)
			if err != nil {
				t.Fatal(err)
			}
			in.Version = connected.Connection.Version
			d.saved = nil
			c := &d.f.Connection
			c.SyncEnabled = true
			generation := c.Generation
			c.LastFullGeneration, c.LastFullSuccessAt = &generation, &now
			planned := now.Add(10 * time.Minute)
			if tc.initial {
				c.LastFullGeneration = nil
				planned = now
			}
			if tc.failed {
				code := "github_unavailable"
				c.PollErrorCode = &code
				planned = now.Add(30 * time.Second)
			}
			if tc.active {
				kind := WorkPoll
				c.ClaimKind = &kind
			}
			c.NextPollAt = &planned
			out, err := ManageProjectApp(t.Context(), d, p, "settings", in, tc.minutes, false, "", proof)
			if err != nil || d.saved == nil || d.saved.Configuration.NextPollAt == nil || !d.saved.Configuration.NextPollAt.Equal(tc.want) || d.saved.ClearWork || out.Connection.Generation != generation {
				t.Fatalf("schedule: write=%+v result=%+v error=%v", d.saved, out, err)
			}
		})
	}
}

func TestProjectAppStopAndReconnectPreserveIntent(t *testing.T) {
	d, p, in, proof := appRuleFixture()
	out, err := ManageProjectApp(t.Context(), d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof)
	if err != nil {
		t.Fatal(err)
	}
	in.Version = out.Connection.Version
	d.f.Connection.AccessState = "unavailable"
	out, err = ManageProjectApp(t.Context(), d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof)
	if err != nil || out.Connection.SyncEnabled || d.saved.Configuration.NextPollAt != nil || d.saved.Configuration.AccessState != "available" {
		t.Fatalf("reconnect with sync off: write=%+v result=%+v error=%v", d.saved, out, err)
	}
	in.Version = out.Connection.Version
	d.f.Connection.SyncEnabled = true
	now := time.Unix(100, 0)
	d.f.Connection.NextPollAt, d.f.Connection.NextAccessCheckAt = &now, &now
	generation := d.f.Connection.Generation
	out, err = ManageProjectApp(t.Context(), d, p, "sync", in, 0, false, "", proof)
	if err != nil || out.Connection.SyncEnabled || !out.Connection.Enabled || out.Connection.Generation != generation+1 || d.saved.Configuration.NextPollAt != nil || d.saved.Configuration.NextAccessCheckAt != nil {
		t.Fatalf("disable sync: write=%+v result=%+v error=%v", d.saved, out, err)
	}
	in.Version = out.Connection.Version
	d.f.Connection.NextPollAt, d.f.Connection.NextAccessCheckAt = nil, nil
	out, err = ManageProjectApp(t.Context(), d, p, "settings", in, 10, false, "", proof)
	if err != nil || out.Connection.SyncEnabled || d.saved.Configuration.NextPollAt != nil || d.saved.Configuration.NextAccessCheckAt != nil || out.Connection.Generation != generation+1 {
		t.Fatalf("settings while off: write=%+v result=%+v error=%v", d.saved, out, err)
	}
}

func TestProjectAppSettingsRefuseExhaustionAndStaleNoop(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*githubpr.Connection)
	}{
		{"version", func(c *githubpr.Connection) { c.Version = math.MaxInt64 }},
		{"revision", func(c *githubpr.Connection) { c.Revision = math.MaxInt64 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, p, in, proof := appRuleFixture()
			tc.mutate(&d.f.Connection)
			in.Version = d.f.Connection.Version
			_, err := ManageProjectApp(t.Context(), d, p, "settings", in, 10, false, "", proof)
			if appRuleFaultCode(err) != "version_exhausted" || d.saved != nil {
				t.Fatalf("exhaustion: write=%+v error=%v", d.saved, err)
			}
		})
	}
	d, p, in, proof := appRuleFixture()
	in.Version++
	_, err := ManageProjectApp(t.Context(), d, p, "settings", in, d.f.Connection.PollIntervalMinutes, false, "", proof)
	if appRuleFaultCode(err) != "version_conflict" || d.saved != nil {
		t.Fatalf("stale no-op: write=%+v error=%v", d.saved, err)
	}
}

func TestProjectAppSettingsPropagateFailures(t *testing.T) {
	problem := errors.New("store failure")
	for _, tc := range []struct {
		name     string
		setup    func(*projectAppRuleDAO)
		expected error
		code     string
	}{
		{"clock", func(d *projectAppRuleDAO) {
			d.f.Connection.Enabled, d.f.Connection.SyncEnabled, d.clockErr = true, true, problem
		}, problem, "internal"},
		{"save", func(d *projectAppRuleDAO) { d.saveErr = problem }, problem, "internal"},
		{"conflict", func(d *projectAppRuleDAO) { d.conflict = true }, nil, "version_conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, p, in, proof := appRuleFixture()
			tc.setup(d)
			_, err := ManageProjectApp(t.Context(), d, p, "settings", in, 10, false, "", proof)
			if appRuleFaultCode(err) != tc.code || tc.expected != nil && !errors.Is(err, tc.expected) {
				t.Fatalf("error=%v", err)
			}
			if tc.name == "clock" && d.saved != nil || tc.name != "clock" && d.saved == nil {
				t.Fatalf("unexpected save attempt: %+v", d.saved)
			}
		})
	}
}

func TestProjectAppSyncEnableRetainsBackoffAndChecksAuthority(t *testing.T) {
	d, p, in, proof := appRuleFixture()
	out, err := ManageProjectApp(t.Context(), d, p, "connect", in, 0, false, d.f.Project.RepoURL, proof)
	if err != nil {
		t.Fatal(err)
	}
	in.Version = out.Connection.Version
	backoff := time.Unix(3700, 0)
	d.f.Connection.NotBefore = &backoff
	generation := d.f.Connection.Generation
	out, err = ManageProjectApp(t.Context(), d, p, "sync", in, 0, true, "", proof)
	if err != nil || !out.Connection.SyncEnabled || out.Connection.Generation != generation+1 || d.saved.ClearWork || d.saved.Configuration.NextPollAt == nil || !d.saved.Configuration.NextPollAt.Equal(time.Unix(100, 0)) || out.Connection.NotBefore == nil || !out.Connection.NotBefore.Equal(backoff) {
		t.Fatalf("enable sync: write=%+v result=%+v error=%v", d.saved, out, err)
	}
	d, p, in, proof = appRuleFixture()
	d.f.Access.Role = model.ProjectMemberRole
	_, err = ManageProjectApp(t.Context(), d, p, "sync", in, 0, false, "", proof)
	if appRuleFaultCode(err) != "forbidden" || d.saved != nil {
		t.Fatalf("member no-op: write=%+v error=%v", d.saved, err)
	}
}
