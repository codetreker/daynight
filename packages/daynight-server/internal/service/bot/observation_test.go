package bot

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type observationTestRead struct {
	bot                                    model.Bot
	source                                 store.BotObservationSource
	at                                     time.Time
	begin, get, sourceError, clock, finish error
}

type observationTestScope struct {
	store.SnapshotScope
	store.BotReader
	f     *observationTestFixture
	index int
}

func (s *observationTestScope) BotDAO() store.BotReader { return s }
func (s *observationTestScope) BotObservation(ctx context.Context, owner, id string) (store.BotObservationSource, error) {
	s.f.event(ctx, fmt.Sprintf("source%d", s.index))
	if owner != s.f.principal.UserID || id != s.f.id || !s.f.inside {
		s.f.t.Fatalf("source ownership/scope: owner=%s id=%s inside=%v", owner, id, s.f.inside)
	}
	r := s.f.reads[s.index]
	return r.source, r.sourceError
}
func (s *observationTestScope) ObservedAt(ctx context.Context) (time.Time, error) {
	s.f.event(ctx, fmt.Sprintf("clock%d", s.index))
	if !s.f.inside {
		s.f.t.Fatal("clock escaped snapshot")
	}
	r := s.f.reads[s.index]
	return r.at, r.clock
}

type observationTestFixture struct {
	store.BotWriter
	t          *testing.T
	ctx        context.Context
	principal  model.Principal
	id         string
	service    *Bots
	reads      []observationTestRead
	readCount  int
	inside     bool
	live       store.BotSessionLive
	liveError  error
	afterLive  func()
	afterRead  func(int)
	events     []string
	wantEvents []string
}

func (f *observationTestFixture) event(ctx context.Context, name string) {
	f.t.Helper()
	if ctx != f.ctx {
		f.t.Fatalf("%s changed caller context", name)
	}
	f.events = append(f.events, name)
}
func (f *observationTestFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	i := f.readCount
	f.readCount++
	if i >= len(f.reads) {
		f.t.Fatal("unexpected snapshot")
	}
	f.event(ctx, fmt.Sprintf("begin%d", i))
	r := f.reads[i]
	if r.begin != nil {
		return r.begin
	}
	if f.inside {
		f.t.Fatal("nested snapshot")
	}
	f.inside = true
	err := fn(&observationTestScope{f: f, index: i})
	f.inside = false
	f.event(ctx, fmt.Sprintf("end%d", i))
	if f.afterRead != nil {
		f.afterRead(i)
	}
	if r.finish != nil {
		return r.finish
	}
	return err
}
func (f *observationTestFixture) ObserveBotSession(ctx context.Context, source *store.BotSessionSource) (store.BotSessionLive, error) {
	f.event(ctx, "live")
	if f.inside || f.readCount != 1 || source != f.reads[0].source.Session {
		f.t.Fatalf("live sample before completed original snapshot: inside=%v reads=%d", f.inside, f.readCount)
	}
	if f.afterLive != nil {
		f.afterLive()
	}
	return f.live, f.liveError
}

func observationReadEvents(i int) []string {
	return []string{fmt.Sprintf("begin%d", i), fmt.Sprintf("get%d", i), fmt.Sprintf("source%d", i), fmt.Sprintf("clock%d", i), fmt.Sprintf("end%d", i)}
}
func newObservationTestFixture(t *testing.T) *observationTestFixture {
	t.Helper()
	ctx := context.WithValue(t.Context(), struct{}{}, "observation caller")
	f := &observationTestFixture{t: t, ctx: ctx, principal: testPrincipal(), id: uuid.NewString()}
	at := time.Date(2026, 11, 20, 4, 0, 0, 0, time.UTC)
	worker, session, execution, native := uuid.NewString(), uuid.NewString(), uuid.NewString(), "original-native-session"
	instance := uuid.NewString()
	bot := model.Bot{ID: f.id, Version: 7, OwnerUserID: f.principal.UserID, WorkerID: worker,
		ResolvedConfiguration: model.BotConfiguration{Provider: "codex"}, SessionID: &session, TestExecutionID: &execution,
		StartupResult: model.BotStartupResult{State: "ready"}}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: session, TestExecutionID: execution, ExecutionGeneration: "2"}, ConnectionEpoch: "3"}
	for range 2 {
		f.reads = append(f.reads, observationTestRead{bot: bot, at: at, source: store.BotObservationSource{
			Worker: &model.WorkerSnapshot{UserID: f.principal.UserID, WorkerID: worker, LastReportedAt: at.Add(-time.Second),
				Telemetry: model.WorkerTelemetry{Machine: model.WorkerMachine{ID: "machine-1", Name: "original-machine"}}},
			Session: &store.BotSessionSource{Snapshot: sp.Snapshot{ControllerFence: fence, Lifecycle: "active",
				Identity: sp.Identity{OwnerUserID: f.principal.UserID, Provider: "codex", NativeSessionID: &native}},
				LastSeen: pointer(at.Add(-time.Second)), ConnectionExpiry: pointer(at.Add(20 * time.Second)), ServerInstance: instance},
		}})
	}
	f.live = store.BotSessionLive{ObservedAt: at, Available: true, Fence: fence, ConnectionState: "connected", Synchronized: true, SourceSynced: true, Activity: "working", CurrentTurnID: pointer("turn-1")}
	f.service = New(f).WithSessionObserver(f)
	f.service.operations.get = func(ctx context.Context, scope store.SnapshotScope, p model.Principal, id string) (model.Bot, error) {
		s, ok := scope.(*observationTestScope)
		if !ok || s.f != f || !f.inside || p != f.principal || id != f.id {
			t.Fatal("get changed authenticated read scope")
		}
		f.event(ctx, fmt.Sprintf("get%d", s.index))
		r := f.reads[s.index]
		return r.bot, r.get
	}
	f.wantEvents = append(observationReadEvents(0), "live")
	f.wantEvents = append(f.wantEvents, observationReadEvents(1)...)
	t.Cleanup(func() {
		if !reflect.DeepEqual(f.events, f.wantEvents) {
			t.Errorf("events=%v, want=%v", f.events, f.wantEvents)
		}
	})
	return f
}

func TestObservationReadsReauthorizeAfterCommittedLiveSample(t *testing.T) {
	f := newObservationTestFixture(t)
	f.reads[1].at = f.reads[1].at.Add(time.Second)
	f.reads[1].source.Worker.Telemetry.Machine.Name = "renamed-machine"
	out, err := f.service.Observation(f.ctx, f.principal, strings.ToUpper(f.id))
	if err != nil {
		t.Fatal(err)
	}
	if out.State != "working" || out.BotID != f.id || out.BotVersion != 7 || out.Machine == nil || out.Machine.Name != "renamed-machine" || out.CurrentTurnID == nil || *out.CurrentTurnID != "turn-1" || !out.ObservedAt.Equal(f.reads[1].at) {
		t.Fatalf("observation did not use final binding plus live state: %+v", out)
	}
}

func TestObservationDropsActivityAcrossBindingOrLeaseChanges(t *testing.T) {
	for _, change := range []string{"version", "lease", "fence", "offline", "instance", "sample expired"} {
		t.Run(change, func(t *testing.T) {
			f := newObservationTestFixture(t)
			f.afterLive = func() {
				switch change {
				case "version":
					f.reads[1].bot.Version++
				case "lease":
					f.reads[1].source.Session.ConnectionExpiry = nil
				case "fence":
					f.reads[1].source.Session.Snapshot.ConnectionEpoch = "4"
				case "offline":
					f.reads[1].source.Worker.LastReportedAt = f.reads[1].at.Add(-time.Hour)
				case "instance":
					f.reads[1].source.Session.ServerInstance = uuid.NewString()
				case "sample expired":
					fresh := f.reads[1].at.Add(31 * time.Second)
					f.reads[1].at = fresh
					f.reads[1].source.Worker.LastReportedAt = fresh
					f.reads[1].source.Session.LastSeen = &fresh
					f.reads[1].source.Session.ConnectionExpiry = pointer(fresh.Add(time.Minute))
				}
			}
			out, err := f.service.Observation(f.ctx, f.principal, f.id)
			if err != nil {
				t.Fatal(err)
			}
			if out.State == "working" || out.CurrentTurnID != nil || out.BotVersion != f.reads[1].bot.Version {
				t.Fatalf("published old activity: %+v", out)
			}
		})
	}
}

func TestObservationRefusalsAndReadFailuresDoNotPublish(t *testing.T) {
	for _, stage := range []string{"begin", "get", "deleted", "source", "clock", "finish"} {
		for _, index := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s%d", stage, index), func(t *testing.T) {
				f := newObservationTestFixture(t)
				cause := errors.New("controlled " + stage + " failure")
				r := &f.reads[index]
				switch stage {
				case "begin":
					r.begin = cause
				case "get":
					r.get = cause
				case "deleted":
					r.bot.Deletion = &model.BotDeletion{}
				case "source":
					r.sourceError = cause
				case "clock":
					r.clock = cause
				case "finish":
					r.finish = cause
				}
				f.wantEvents = nil
				if index == 1 {
					f.wantEvents = append(observationReadEvents(0), "live")
				}
				f.wantEvents = append(f.wantEvents, fmt.Sprintf("begin%d", index))
				if stage != "begin" {
					f.wantEvents = append(f.wantEvents, fmt.Sprintf("get%d", index))
					if stage != "get" && stage != "deleted" {
						f.wantEvents = append(f.wantEvents, fmt.Sprintf("source%d", index))
						if stage != "source" {
							f.wantEvents = append(f.wantEvents, fmt.Sprintf("clock%d", index))
						}
					}
					f.wantEvents = append(f.wantEvents, fmt.Sprintf("end%d", index))
				}
				out, err := f.service.Observation(f.ctx, f.principal, f.id)
				if err == nil || !reflect.DeepEqual(out, botcore.Observation{}) {
					t.Fatalf("failure published result: %+v %v", out, err)
				}
				if stage == "deleted" {
					requireFault(t, err, "not_found")
				} else if !errors.Is(err, cause) {
					t.Fatalf("lost error chain: %v", err)
				}
			})
		}
	}
	for _, code := range []string{"forbidden", "unauthenticated"} {
		t.Run(code, func(t *testing.T) {
			f := newObservationTestFixture(t)
			f.reads[1].get = &model.Fault{Code: code, Message: "Current authorization was revoked."}
			f.wantEvents = append(append(observationReadEvents(0), "live"), "begin1", "get1", "end1")
			out, err := f.service.Observation(f.ctx, f.principal, f.id)
			requireFault(t, err, code)
			if !reflect.DeepEqual(out, botcore.Observation{}) {
				t.Fatalf("revoked read published: %+v", out)
			}
		})
	}
}

func TestObservationSampleErrorAndCancellationSuppressResults(t *testing.T) {
	t.Run("sample error", func(t *testing.T) {
		f := newObservationTestFixture(t)
		f.liveError = errors.New("sample unavailable")
		f.wantEvents = append(observationReadEvents(0), "live")
		out, err := f.service.Observation(f.ctx, f.principal, f.id)
		if !errors.Is(err, f.liveError) || !reflect.DeepEqual(out, botcore.Observation{}) {
			t.Fatalf("sample error result: %+v %v", out, err)
		}
	})
	t.Run("cancel during sample", func(t *testing.T) {
		f := newObservationTestFixture(t)
		ctx, cancel := context.WithCancel(f.ctx)
		defer cancel()
		f.ctx = ctx
		f.afterLive = func() { cancel(); f.liveError = ctx.Err() }
		f.wantEvents = append(observationReadEvents(0), "live")
		out, err := f.service.Observation(ctx, f.principal, f.id)
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(out, botcore.Observation{}) {
			t.Fatalf("sample cancel result: %+v %v", out, err)
		}
	})
	t.Run("cancel after final snapshot", func(t *testing.T) {
		f := newObservationTestFixture(t)
		ctx, cancel := context.WithCancel(f.ctx)
		defer cancel()
		f.ctx = ctx
		f.afterRead = func(index int) {
			if index == 1 {
				cancel()
			}
		}
		out, err := f.service.Observation(ctx, f.principal, f.id)
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(out, botcore.Observation{}) {
			t.Fatalf("final cancel result: %+v %v", out, err)
		}
	})
}

func TestObservationAdmissionDoesNotReadOrSample(t *testing.T) {
	for _, invalid := range []string{"principal", "id", "observer"} {
		t.Run(invalid, func(t *testing.T) {
			f := newObservationTestFixture(t)
			f.wantEvents = nil
			p, id := f.principal, f.id
			switch invalid {
			case "principal":
				p = model.Principal{}
			case "id":
				id = "invalid"
			case "observer":
				f.service.observer = nil
			}
			out, err := f.service.Observation(f.ctx, p, id)
			if err == nil || !reflect.DeepEqual(out, botcore.Observation{}) {
				t.Fatalf("invalid admission: %+v %v", out, err)
			}
			if invalid == "observer" {
				requireFault(t, err, "service_unavailable")
			}
		})
	}
}
