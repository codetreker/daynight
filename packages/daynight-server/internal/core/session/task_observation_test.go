package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func observationFixture(t *testing.T) (*Engine, model.Principal, store.TaskSessionSource, *liveSession) {
	t.Helper()
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	source, live := taskListSource(now)
	actor := model.Principal{Kind: model.PATCredential, UserID: "77777777-7777-4777-8777-777777777777", CredentialID: "88888888-8888-4888-8888-888888888888"}
	source.ProjectID, source.TaskVersion = source.Session.ProjectID, 19
	source.Worker.UserID, source.Worker.Agent = actor.UserID, model.AgentCodex
	source.Session.OwnerID, source.Session.Backend = actor.UserID, "web"
	source.Session.InitialInputState = "confirmed"
	native := "native-session"
	source.Session.Identity.NativeSessionID, source.Session.Identity.Provider = &native, "codex"
	expiry := now.Add(time.Minute)
	source.Session.ConnectionExpiry = &expiry
	live.Snapshot.Activity = "idle"
	live.Snapshot.Capabilities = sp.Capabilities{Send: true, Steer: true}
	live.Synced = true
	engine := NewEngine(nil)
	engine.now = func() time.Time { return now }
	engine.live[source.Session.SessionID] = &liveCell{value: live}
	return engine, actor, source, live
}

func TestTaskObservationSeparatesIndicatorAndSending(t *testing.T) {
	for _, test := range []struct {
		name                                string
		change                              func(*Engine, *model.Principal, *store.TaskSessionSource, *liveSession)
		indicator, reason, sendReason, mode string
		allowed                             bool
	}{
		{name: "idle owner", indicator: "warning", reason: "idle", sendReason: "allowed", mode: "start", allowed: true},
		{name: "other member", change: func(_ *Engine, p *model.Principal, _ *store.TaskSessionSource, _ *liveSession) {
			p.UserID = "99999999-9999-4999-8999-999999999999"
		}, indicator: "warning", reason: "idle", sendReason: "not_owner"},
		{name: "working steer", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "working"
			turn := "turn"
			l.Snapshot.CurrentTurnID = &turn
		}, indicator: "working", reason: "working", sendReason: "allowed", mode: "steer", allowed: true},
		{name: "working no steer", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "working"
			turn := "turn"
			l.Snapshot.CurrentTurnID = &turn
			l.Snapshot.Capabilities.Steer = false
		}, indicator: "working", reason: "working", sendReason: "steer_unavailable"},
		{name: "working no turn", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "working"
		}, indicator: "working", reason: "working", sendReason: "turn_unavailable"},
		{name: "waiting input", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "waiting_input"
		}, indicator: "notice", reason: "waiting_input", sendReason: "waiting_input"},
		{name: "stopped", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Activity = "stopped"
		}, indicator: "warning", reason: "stopped", sendReason: "stopped"},
		{name: "synchronizing", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.ConnectionState = "synchronizing"
			l.Snapshot.Synchronized = false
		}, reason: "synchronizing", sendReason: "synchronizing"},
		{name: "no live", change: func(e *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			delete(e.live, s.Session.SessionID)
		}, indicator: "warning", reason: "disconnected", sendReason: "disconnected"},
		{name: "heartbeat expired", change: func(e *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			expired := e.now().Add(-HeartbeatTimeout - time.Nanosecond)
			s.Session.LastSeen = &expired
		}, indicator: "warning", reason: "disconnected", sendReason: "disconnected"},
		{name: "connection expired", change: func(e *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			expired := e.now()
			s.Session.ConnectionExpiry = &expired
		}, indicator: "warning", reason: "idle", sendReason: "connection_expired"},
		{name: "initial input pending", change: func(_ *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			s.Session.InitialInputState = "accepted"
		}, indicator: "warning", reason: "idle", sendReason: "initial_input_pending"},
		{name: "native missing", change: func(_ *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			s.Session.Identity.NativeSessionID = nil
		}, indicator: "warning", reason: "idle", sendReason: "native_session_unavailable"},
		{name: "capability absent", change: func(_ *Engine, _ *model.Principal, _ *store.TaskSessionSource, l *liveSession) {
			l.Snapshot.Capabilities.Send = false
		}, indicator: "warning", reason: "idle", sendReason: "send_unsupported"},
		{name: "worker complete", change: func(_ *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.State = model.WorkerCompleted
		}, indicator: "warning", reason: "idle", sendReason: "execution_inactive"},
		{name: "task done", change: func(_ *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			s.TaskStatus = model.TaskDone
		}, reason: "idle", sendReason: "execution_inactive"},
		{name: "archived", change: func(_ *Engine, _ *model.Principal, s *store.TaskSessionSource, _ *liveSession) {
			s.Session.Lifecycle = "archived"
		}, indicator: "warning", reason: "archived", sendReason: "archived"},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, p, s, l := observationFixture(t)
			if test.change != nil {
				test.change(e, &p, &s, l)
			}
			before := cloneLive(l)
			result, err := e.ObserveTaskSessions(t.Context(), p, []store.TaskSessionSource{s})
			if err != nil {
				t.Fatal(err)
			}
			got := result[s.TaskID]
			indicator, mode := "", ""
			if got.Indicator != nil {
				indicator = *got.Indicator
			}
			if got.Send.Mode != nil {
				mode = *got.Send.Mode
			}
			if indicator != test.indicator || got.Reason != test.reason || got.Send.Allowed == nil || *got.Send.Allowed != test.allowed || got.Send.Reason != test.sendReason || mode != test.mode {
				t.Fatalf("observation: %#v send=%#v", got, got.Send)
			}
			if got.ObservedAt == nil || !got.ObservedAt.Equal(e.now()) || got.FreshUntil == nil || got.FreshUntil.After(e.now().Add(30*time.Second)) {
				t.Fatalf("freshness: %#v", got)
			}
			web, err := e.TaskListSessionStates(t.Context(), []store.TaskSessionSource{s})
			if err != nil {
				t.Fatal(err)
			}
			webIndicator := string(web[s.TaskID])
			if webIndicator == "pending" {
				webIndicator = ""
			}
			if indicator != webIndicator {
				t.Fatalf("CLI indicator %q differs from Web %q", indicator, webIndicator)
			}
			if !reflect.DeepEqual(before, l) {
				t.Fatal("observation mutated live state")
			}
		})
	}
}

func TestTaskObservationDistinguishesAbsenceAndChangedExecution(t *testing.T) {
	for _, test := range []struct {
		name                              string
		change                            func(*Engine, *store.TaskSessionSource, *liveSession)
		registration, observation, reason string
	}{
		{"no worker", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Worker = nil; s.Session = nil }, "not_applicable", "observed", "no_execution"},
		{"not started", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker = nil
			s.Session = nil
			s.TaskStatus = model.TaskTodo
		}, "not_applicable", "observed", "not_started"},
		{"not registered", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Session = nil }, "not_registered", "observed", "not_registered"},
		{"worker removed", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Worker = nil }, "unknown", "unavailable", "execution_changed"},
		{"claim changed", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.ClaimID = "99999999-9999-4999-8999-999999999999"
		}, "unknown", "unavailable", "execution_changed"},
		{"live changed", func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.ExecutionGeneration = "8" }, "unknown", "unavailable", "execution_changed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, p, s, l := observationFixture(t)
			test.change(e, &s, l)
			got, err := e.ObserveTaskSessions(t.Context(), p, []store.TaskSessionSource{s})
			if err != nil {
				t.Fatal(err)
			}
			v := got[s.TaskID]
			if v.Registration != test.registration || v.Observation != test.observation || v.Reason != test.reason || v.Indicator != nil {
				t.Fatalf("observation: %#v", v)
			}
			if v.Observation == "unavailable" && (v.Error == nil || v.Send.Allowed != nil) {
				t.Fatalf("unavailable: %#v", v)
			}
		})
	}
}
func TestTaskInspectionRetainsHistoricalIdentityWithoutSending(t *testing.T) {
	for _, test := range []struct {
		name          string
		workerPresent bool
	}{{"replacement claim", true}, {"removed worker", false}} {
		t.Run(test.name, func(t *testing.T) {
			e, p, s, _ := observationFixture(t)
			old := s.Session.ClaimID
			if test.workerPresent {
				s.Worker.ClaimID = "99999999-9999-4999-8999-999999999999"
			} else {
				s.Worker = nil
			}
			s.Session.ArchiveState = "ready"
			got, err := e.InspectTaskSession(t.Context(), p, s)
			if err != nil {
				t.Fatal(err)
			}
			if got.CurrentBinding || got.Fence.ClaimID != old || got.Source != "archive" || got.Session.Send.Allowed == nil || *got.Session.Send.Allowed || got.Session.Send.Reason != "not_current" || got.Session.Indicator != nil {
				t.Fatalf("inspection: %#v", got)
			}
		})
	}
}

func TestTaskInspectionReportsOnlyReadableSources(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Engine, *store.TaskSessionSource, *liveSession)
		want   string
	}{
		{"live", nil, "live"},
		{"unsynchronized snapshot", func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Snapshot.Synchronized = false }, "unavailable"},
		{"uncommitted source", func(_ *Engine, _ *store.TaskSessionSource, l *liveSession) { l.Synced = false }, "unavailable"},
		{"expired connection", func(e *Engine, s *store.TaskSessionSource, _ *liveSession) {
			at := e.now()
			s.Session.ConnectionExpiry = &at
		}, "unavailable"},
		{"missing connection expiry", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) { s.Session.ConnectionExpiry = nil }, "unavailable"},
		{"draining live", func(e *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Session.Lifecycle = "draining"
			at := e.now().Add(time.Minute)
			s.Session.DrainUntil = &at
		}, "live"},
		{"drain deadline", func(e *Engine, s *store.TaskSessionSource, _ *liveSession) { at := e.now(); s.Session.DrainUntil = &at }, "unavailable"},
		{"archive fallback", func(_ *Engine, s *store.TaskSessionSource, l *liveSession) {
			s.Session.ArchiveState = "ready"
			l.Snapshot.Synchronized = false
		}, "archive"},
		{"terminal recording", func(e *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.AgentControlMode = model.AgentControlModeHerdr
			s.Session.Backend = "herdr"
			s.Session.Identity.AgentControlMode = "herdr"
			s.Session.ServerInstance = e.instance
		}, "unavailable"},
		{"terminal archive", func(_ *Engine, s *store.TaskSessionSource, _ *liveSession) {
			s.Worker.AgentControlMode = model.AgentControlModeHerdr
			s.Session.Backend = "herdr"
			s.Session.Identity.AgentControlMode = "herdr"
			s.Session.ArchiveState = "ready"
		}, "archive"},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, p, source, live := observationFixture(t)
			if test.change != nil {
				test.change(e, &source, live)
			}
			got, err := e.InspectTaskSession(t.Context(), p, source)
			if err != nil || got.Source != test.want {
				t.Fatalf("source=%q want %q: %v", got.Source, test.want, err)
			}
		})
	}
}

func TestTaskInspectionPreservesSelectedIdentityOnLiveReplacement(t *testing.T) {
	e, p, source, live := observationFixture(t)
	live.Snapshot.ExecutionGeneration = "9"
	got, err := e.InspectTaskSession(t.Context(), p, source)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != "unavailable" || got.Fence != source.Session.Fence || got.Session.SessionID == nil || *got.Session.SessionID != got.SessionID || got.Session.ClaimID == nil || *got.Session.ClaimID != got.Fence.ClaimID || got.Session.ExecutionGeneration == nil || *got.Session.ExecutionGeneration != got.Fence.ExecutionGeneration || got.Session.ConnectionEpoch == nil || *got.Session.ConnectionEpoch != got.Fence.ConnectionEpoch || got.Session.Observation != "unavailable" || got.Session.Reason != "execution_changed" || got.Session.Send.Allowed != nil {
		t.Fatalf("replacement inspection: %#v", got)
	}
}

func TestTaskInspectionRejectsCorruptPersistedIdentity(t *testing.T) {
	e, p, source, _ := observationFixture(t)
	source.Session.Fence.SessionID = "99999999-9999-4999-8999-999999999999"
	_, err := e.InspectTaskSession(t.Context(), p, source)
	var failure *model.Fault
	if !errors.As(err, &failure) || failure.Code != "source_corrupt" {
		t.Fatalf("identity corruption: %v", err)
	}
}
func TestTaskObservationHerdrHasNoFabricatedActivity(t *testing.T) {
	e, p, s, _ := observationFixture(t)
	s.Worker.AgentControlMode = model.AgentControlModeHerdr
	s.Session.Backend = "herdr"
	s.Session.Identity.AgentControlMode = "herdr"
	s.Session.ServerInstance = e.instance
	got, err := e.ObserveTaskSessions(t.Context(), p, []store.TaskSessionSource{s})
	if err != nil {
		t.Fatal(err)
	}
	v := got[s.TaskID]
	if v.ContentKind == nil || *v.ContentKind != "terminal_recording" || v.Activity != nil || v.Indicator != nil || v.Send.Allowed == nil || *v.Send.Allowed || v.Send.Reason != "unsupported_mode" || v.ConnectionState == nil || *v.ConnectionState != "connected" {
		t.Fatalf("herdr: %#v", v)
	}
}
func TestTaskObservationHonorsCancellationAndAdmission(t *testing.T) {
	e, p, s, _ := observationFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := e.ObserveTaskSessions(ctx, p, []store.TaskSessionSource{s}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	e.CancelWork()
	if _, err := e.ObserveTaskSessions(t.Context(), p, []store.TaskSessionSource{s}); err == nil {
		t.Fatal("accepted after stop")
	}
}

func TestTaskInspectionHonorsIdentityCancellationAndStop(t *testing.T) {
	e, p, source, _ := observationFixture(t)
	if _, err := e.InspectTaskSession(t.Context(), model.Principal{}, source); err == nil {
		t.Fatal("unauthenticated inspection accepted")
	}
	missing := source
	missing.Session = nil
	if _, err := e.InspectTaskSession(t.Context(), p, missing); err == nil {
		t.Fatal("missing Session accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := e.InspectTaskSession(ctx, p, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	e.CancelWork()
	if _, err := e.InspectTaskSession(t.Context(), p, source); err == nil {
		t.Fatal("inspection accepted after stop")
	}
}

func TestTaskObservationCopiesLiveAndDurablePointers(t *testing.T) {
	e, p, source, live := observationFixture(t)
	turn := "original-turn"
	live.Snapshot.CurrentTurnID = &turn
	beforeLive, beforeNative, beforeSeen := cloneLive(live), *source.Session.Identity.NativeSessionID, *source.Session.LastSeen
	result, err := e.ObserveTaskSessions(t.Context(), p, []store.TaskSessionSource{source})
	if err != nil {
		t.Fatal(err)
	}
	got := result[source.TaskID]
	*got.CurrentTurnID = "client-change"
	*got.NativeSessionID = "client-change"
	*got.LastSeenAt = time.Time{}
	if !reflect.DeepEqual(beforeLive, live) || *source.Session.Identity.NativeSessionID != beforeNative || !source.Session.LastSeen.Equal(beforeSeen) {
		t.Fatal("observation aliases committed live or durable state")
	}
}

func TestTaskObservationPublishesUTCTimestamps(t *testing.T) {
	for _, clock := range []struct {
		name              string
		connectionLimited bool
	}{
		{name: "heartbeat deadline"},
		{name: "connection deadline", connectionLimited: true},
	} {
		for _, inspect := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/inspection=%t", clock.name, inspect), func(t *testing.T) {
				engine, actor, source, _ := observationFixture(t)
				now := engine.now()
				engine.now = func() time.Time { return now.In(time.FixedZone("server", 9*60*60)) }
				lastSeen := now.Add(-time.Second).In(time.FixedZone("database", 8*60*60))
				expiry := now.Add(time.Minute).In(time.FixedZone("credential", -5*60*60))
				wantFresh := lastSeen.Add(HeartbeatTimeout)
				if clock.connectionLimited {
					expiry = now.Add(5 * time.Second).In(expiry.Location())
					wantFresh = expiry
				}
				source.Session.LastSeen, source.Session.ConnectionExpiry = &lastSeen, &expiry
				originalLastSeen, originalExpiry := lastSeen, expiry
				var got sp.TaskSessionObservation
				if inspect {
					result, err := engine.InspectTaskSession(t.Context(), actor, source)
					if err != nil {
						t.Fatal(err)
					}
					got = result.Session
				} else {
					result, err := engine.ObserveTaskSessions(t.Context(), actor, []store.TaskSessionSource{source})
					if err != nil {
						t.Fatal(err)
					}
					got = result[source.TaskID]
				}
				encoded, err := json.Marshal(got)
				if err != nil {
					t.Fatal(err)
				}
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(encoded, &fields); err != nil {
					t.Fatal(err)
				}
				for name, instant := range map[string]time.Time{"observedAt": now, "lastSeenAt": originalLastSeen, "freshUntil": wantFresh} {
					var stamp string
					if err := json.Unmarshal(fields[name], &stamp); err != nil {
						t.Fatal(err)
					}
					if want := instant.UTC().Format(time.RFC3339Nano); stamp != want {
						t.Errorf("%s = %q, want UTC timestamp %q", name, stamp, want)
					}
				}
				if *source.Session.LastSeen != originalLastSeen || *source.Session.ConnectionExpiry != originalExpiry {
					t.Fatal("observation changed the stored source timestamps")
				}
			})
		}
	}
}
