package sessionrelay

import (
	"context"
	"reflect"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestCurrentStartupNegotiationFiltersStaleReports(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	before, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task)
	if err != nil || before["status"] != "not_registered" {
		t.Fatalf("unregistered current: %#v %v", before, err)
	}
	if _, exists := before["startupReport"]; exists {
		t.Fatal("unregistered response changed shape")
	}
	v, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if err != nil {
		t.Fatal(err)
	}
	read := func(want *sp.StartupReport) {
		t.Helper()
		old, err := f.s.Current(ctx, f.p, f.project, f.task)
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := old["startupReport"]; exists {
			t.Fatal("legacy response changed shape")
		}
		current, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task)
		if err != nil {
			t.Fatal(err)
		}
		actual, exists := current["startupReport"]
		if !exists || want == nil && actual != nil || want != nil && !reflect.DeepEqual(actual, want) {
			t.Fatalf("startup report: %#v want %#v", actual, want)
		}
		delete(current, "startupReport")
		if !reflect.DeepEqual(current, old) {
			t.Fatal("negotiation changed existing session fields")
		}
	}
	read(nil)
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: v.SessionID, ClaimID: v.ClaimID, ExecutionGeneration: v.ExecutionGeneration, ControllerInstanceID: v.Identity.ControllerInstanceID, Revision: "1", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode, report.Recovery.State = "unknown", "native_timeout", "none"
	persist := func(r sp.StartupReport) {
		t.Helper()
		if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'sessionStartup',$2) ON CONFLICT(task_id,name) DO UPDATE SET value=excluded.value`, f.task, encode(r)); err != nil {
			t.Fatal(err)
		}
	}
	persist(report)
	read(&report)
	for name, mutate := range map[string]func(*sp.StartupReport){
		"session":    func(r *sp.StartupReport) { r.SessionID = uuid.NewString() },
		"claim":      func(r *sp.StartupReport) { r.ClaimID = uuid.NewString() },
		"generation": func(r *sp.StartupReport) { r.ExecutionGeneration = "2" },
		"instance":   func(r *sp.StartupReport) { r.ControllerInstanceID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) { stale := report; mutate(&stale); persist(stale); read(nil) })
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task); err == nil {
		t.Fatal("revoked credential read startup evidence")
	}
}
