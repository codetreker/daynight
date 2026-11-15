package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskSyncSessionProjection(t *testing.T) {
	for _, test := range []struct {
		name      string
		change    func(*Engine, *store.TaskSessionSource, *liveSession)
		state     string
		legacy    model.SessionListState
		canOpen   bool
		attention *bool
		fresh     bool
	}{
		{name: "working", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Activity = "working" }, state: "working", legacy: model.SessionListWorking, canOpen: true, attention: observationPointer(false), fresh: true},
		{name: "notice", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Activity = "waiting_input" }, state: "notice", legacy: model.SessionListNotice, canOpen: true, attention: observationPointer(true), fresh: true},
		{name: "warning", state: "warning", legacy: model.SessionListWarning, canOpen: true, attention: observationPointer(true), fresh: true},
		{name: "initializing", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Activity = "initializing" }, state: "pending", legacy: model.SessionListPending, canOpen: true, fresh: true},
		{name: "synchronizing", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Synchronized = false }, state: "pending", legacy: model.SessionListPending, fresh: true},
		{name: "unknown readable", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Activity = "unknown" }, state: "unavailable", canOpen: true, fresh: true},
		{name: "unknown synchronizing", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "unknown"
			l.Snapshot.Synchronized = false
		}, state: "unavailable", fresh: true},
		{name: "disconnected", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.ConnectionState = "disconnected"
		}, state: "warning", legacy: model.SessionListWarning, attention: observationPointer(true), fresh: true},
		{name: "archived readable", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Session.Lifecycle = "archived"
			s.Session.ArchiveState = "ready"
		}, state: "warning", legacy: model.SessionListWarning, canOpen: true, attention: observationPointer(true), fresh: true},
		{name: "no heartbeat", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Session.LastSeen = nil }, state: "warning", legacy: model.SessionListWarning, attention: observationPointer(true)},
		{name: "no worker", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Worker = nil; s.Session = nil }, state: "no_session", fresh: true},
		{name: "completed historical session", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Worker.State = model.WorkerCompleted }, state: "no_session", legacy: model.SessionListWarning, fresh: true},
		{name: "unknown worker state", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Worker.State = "unknown" }, state: "unavailable", legacy: model.SessionListWarning},
		{name: "unregistered", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Session = nil }, state: "not_registered", fresh: true},
		{name: "changed binding", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Session.ClaimID = "other" }, state: "unavailable"},
		{name: "live fence changed", change: func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.ConnectionEpoch = "different" }, state: "unavailable", legacy: model.SessionListWarning},
		{name: "herdr connected", change: func(e *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.AgentControlMode = model.AgentControlModeHerdr
			s.Session.Backend = "herdr"
			s.Session.Identity.AgentControlMode = "herdr"
			s.Session.Identity.OwnerUserID = s.Session.OwnerID
			s.Session.ServerInstance = e.instance
		}, state: "unavailable", canOpen: true, fresh: true},
		{name: "herdr disconnected", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.AgentControlMode = model.AgentControlModeHerdr
			s.Session.Backend = "herdr"
			s.Session.Identity.AgentControlMode = "herdr"
			s.Session.Identity.OwnerUserID = s.Session.OwnerID
			s.Session.ServerInstance = "other"
		}, state: "warning", canOpen: true, fresh: true},
		{name: "herdr archive", change: func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.AgentControlMode = model.AgentControlModeHerdr
			s.Session.Backend = "herdr"
			s.Session.Identity.AgentControlMode = "herdr"
			s.Session.Identity.OwnerUserID = s.Session.OwnerID
			s.Session.ArchiveState = "ready"
			final := "final"
			s.Session.TerminalFinalizationID = &final
		}, state: "warning", canOpen: true, fresh: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, principal, source, live := observationFixture(t)
			if test.change != nil {
				test.change(e, &source, live)
			}
			got, legacy, err := e.TaskSyncSessions(t.Context(), principal, []store.TaskSessionSource{source})
			if err != nil {
				t.Fatal(err)
			}
			item, ok := got[source.TaskID]
			if !ok || item.TaskVersion != source.TaskVersion || item.State != test.state || item.CanOpen != test.canOpen || (item.FreshUntil != nil) != test.fresh {
				t.Fatalf("observation = %#v, want state %s, open %v, fresh %v", item, test.state, test.canOpen, test.fresh)
			}
			if (item.NeedsAttention == nil) != (test.attention == nil) || item.NeedsAttention != nil && *item.NeedsAttention != *test.attention {
				t.Fatalf("attention = %v, want %v", item.NeedsAttention, test.attention)
			}
			if item.State != "unavailable" && (item.ObservedAt == nil || !item.ObservedAt.Equal(e.now())) {
				t.Fatalf("observation timestamp = %v", item.ObservedAt)
			}
			if legacy[source.TaskID] != test.legacy {
				t.Fatalf("legacy = %v, want %v", legacy[source.TaskID], test.legacy)
			}
		})
	}
}

func TestTaskSyncSessionProjectionRejectsOwnerAndProviderMismatch(t *testing.T) {
	for _, backend := range []string{"web", "herdr"} {
		for _, mismatch := range []string{"owner", "provider", "missing owner", "missing agent"} {
			t.Run(backend+"/"+mismatch, func(t *testing.T) {
				e, principal, source, _ := observationFixture(t)
				if backend == "herdr" {
					source.Worker.AgentControlMode = model.AgentControlModeHerdr
					source.Session.Backend = "herdr"
					source.Session.Identity.AgentControlMode = "herdr"
					source.Session.Identity.OwnerUserID = source.Session.OwnerID
					source.Session.ServerInstance = e.instance
				}
				before, legacyBefore, err := e.TaskSyncSessions(t.Context(), principal, []store.TaskSessionSource{source})
				if err != nil || !before[source.TaskID].CanOpen {
					t.Fatalf("valid binding: observation=%#v error=%v", before, err)
				}
				switch mismatch {
				case "owner":
					source.Session.OwnerID = "99999999-9999-4999-8999-999999999999"
				case "provider":
					source.Session.Identity.Provider = "claude"
				case "missing owner":
					source.Session.OwnerID, source.Worker.UserID = "", ""
				case "missing agent":
					source.Session.Identity.Provider, source.Worker.Agent = "", ""
				}
				after, legacyAfter, err := e.TaskSyncSessions(t.Context(), principal, []store.TaskSessionSource{source})
				if err != nil {
					t.Fatal(err)
				}
				item := after[source.TaskID]
				if item.State != "unavailable" || item.CanOpen || item.ObservedAt != nil || item.FreshUntil != nil || item.NeedsAttention != nil {
					t.Fatalf("mismatched binding: %#v", item)
				}
				if !reflect.DeepEqual(legacyAfter, legacyBefore) {
					t.Fatalf("legacy changed: before=%v after=%v", legacyBefore, legacyAfter)
				}
			})
		}
	}
}

func TestTaskSyncHerdrRejectsTerminalOwnerMismatch(t *testing.T) {
	for _, owner := range []string{"", "99999999-9999-4999-8999-999999999999"} {
		t.Run("owner="+owner, func(t *testing.T) {
			e, principal, source, _ := observationFixture(t)
			source.Worker.AgentControlMode = model.AgentControlModeHerdr
			source.Session.Backend = "herdr"
			source.Session.Identity.AgentControlMode = "herdr"
			source.Session.Identity.OwnerUserID = owner
			source.Session.ServerInstance = e.instance
			got, legacy, err := e.TaskSyncSessions(t.Context(), principal, []store.TaskSessionSource{source})
			if err != nil {
				t.Fatal(err)
			}
			item := got[source.TaskID]
			if item.State != "unavailable" || item.CanOpen || item.ObservedAt != nil || item.FreshUntil != nil || item.NeedsAttention != nil || len(legacy) != 0 {
				t.Fatalf("unconfirmed terminal owner: observation=%#v legacy=%v", item, legacy)
			}
		})
	}
}

func TestTaskSyncSessionClockAndAdmission(t *testing.T) {
	e, principal, source, _ := observationFixture(t)
	want := e.now().Add(25 * time.Second)
	e.now = func() time.Time { return want }
	observed, err := e.TaskSyncObservedAt(t.Context())
	if err != nil || !observed.Equal(want) {
		t.Fatalf("response clock = %v, %v", observed, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := e.TaskSyncSessions(ctx, principal, []store.TaskSessionSource{source}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled sampling: %v", err)
	}
	if _, err := e.TaskSyncObservedAt(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled clock: %v", err)
	}
	e.now = func() time.Time { return time.Time{} }
	if _, _, err := e.TaskSyncSessions(t.Context(), principal, []store.TaskSessionSource{source}); !syncClockFault(err) {
		t.Fatalf("missing observation clock: %v", err)
	}
	if _, err := e.TaskSyncObservedAt(t.Context()); !syncClockFault(err) {
		t.Fatalf("missing response clock: %v", err)
	}
	if _, _, err := e.TaskSyncSessions(t.Context(), model.Principal{}, nil); err == nil {
		t.Fatal("accepted missing principal")
	}
}

func syncClockFault(err error) bool {
	var f *model.Fault
	return errors.As(err, &f) && f.Code == "session_clock_invalid"
}
