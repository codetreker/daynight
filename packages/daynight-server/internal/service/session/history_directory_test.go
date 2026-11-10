package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type directoryBackend struct {
	HistoryBackend
	current func(context.Context, model.Principal, string, string) (core.TaskCurrentIdentity, error)
	list    func(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
}

func (b directoryBackend) TaskCurrentIdentity(c context.Context, p model.Principal, a, d string) (core.TaskCurrentIdentity, error) {
	return b.current(c, p, a, d)
}
func (b directoryBackend) TaskDirectory(c context.Context, p model.Principal, a, d, s string, n int) (sp.TaskSessionList, error) {
	return b.list(c, p, a, d, s, n)
}

type directoryInspector func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)

func (f directoryInspector) Inspect(c context.Context, p model.Principal, a, b, d string) (sp.TaskSessionInspection, error) {
	return f(c, p, a, b, d)
}

func TestHistoryCurrentNeverSubstitutesHistoricalExecution(t *testing.T) {
	claim, id, mode := "claim", "session", "web"
	p := model.Principal{Kind: model.OAuthCredential, UserID: "actor", CredentialID: "credential"}
	sentinel := errors.New("authorization refused")
	for _, test := range []struct {
		name, status string
		id           *string
		current      bool
		failure      error
		inspections  int
		wantErr      bool
	}{
		{"waiting", "not_applicable", nil, false, nil, 0, false},
		{"unregistered", "not_registered", nil, false, nil, 0, false},
		{"registered", "registered", &id, true, nil, 1, false},
		{"claim changed", "registered", &id, false, nil, 1, true},
		{"refused", "registered", &id, true, sentinel, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			reads, inspections := 0, 0
			backend := directoryBackend{current: func(c context.Context, actual model.Principal, a, b string) (core.TaskCurrentIdentity, error) {
				reads++
				if c != t.Context() || actual != p || a != "project" || b != "task" {
					t.Fatal("identity/context changed")
				}
				return core.TaskCurrentIdentity{Status: test.status, ClaimID: &claim, AgentControlMode: &mode, SessionID: test.id}, test.failure
			}}
			inspect := directoryInspector(func(c context.Context, actual model.Principal, a, b, target string) (sp.TaskSessionInspection, error) {
				inspections++
				if c != t.Context() || actual != p || a != "project" || b != "task" || target != id {
					t.Fatal("inspection retargeted")
				}
				return sp.TaskSessionInspection{SessionID: id, CurrentBinding: test.current, Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim}}}, nil
			})
			result, err := NewHistory(inspect, backend).Current(t.Context(), p, "project", "task")
			if (err != nil) != test.wantErr || reads != 1 || inspections != test.inspections {
				t.Fatalf("result=%+v err=%v reads=%d inspections=%d", result, err, reads, inspections)
			}
			if test.failure != nil && !errors.Is(err, sentinel) {
				t.Fatal("authorization error lost")
			}
			if err == nil && (result.Status != test.status || (result.Session == nil) != (test.id == nil)) {
				t.Fatalf("current identity lost: %+v", result)
			}
		})
	}
}

func TestHistoryDirectoryPreservesBatchAndCursor(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "actor"}
	cursor := "older"
	want := sp.TaskSessionList{Items: []sp.TaskSessionDirectoryItem{{SessionID: "old", CurrentBinding: false}}, NextCursor: &cursor}
	for _, failure := range []error{nil, errors.New("revoked")} {
		calls := 0
		backend := directoryBackend{list: func(c context.Context, actual model.Principal, a, b, after string, limit int) (sp.TaskSessionList, error) {
			calls++
			if c != t.Context() || actual != p || a != "project" || b != "task" || after != "before" || limit != 7 {
				t.Fatal("directory scope or paging changed")
			}
			return want, failure
		}}
		got, err := NewHistory(nil, backend).List(t.Context(), p, "project", "task", "before", 7)
		if calls != 1 || !errors.Is(err, failure) || failure == nil && !reflect.DeepEqual(got, want) {
			t.Fatalf("got=%+v error=%v calls=%d", got, err, calls)
		}
	}
}
