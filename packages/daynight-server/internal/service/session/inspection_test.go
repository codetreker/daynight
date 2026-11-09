package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type inspectionStore struct {
	scope store.SnapshotScope
	err   error
	calls int
	read  func(context.Context, func(store.SnapshotScope) error) error
}

func (s *inspectionStore) ReadSnapshot(ctx context.Context, work func(store.SnapshotScope) error) error {
	s.calls++
	if s.read != nil {
		return s.read(ctx, work)
	}
	if err := work(s.scope); err != nil {
		return err
	}
	return s.err
}

type inspectionSnapshot struct {
	store.SnapshotScope
	credential store.CredentialReader
	project    store.ProjectReader
	session    store.SessionReader
}

func (s inspectionSnapshot) CredentialDAO() store.CredentialReader { return s.credential }
func (s inspectionSnapshot) ProjectDAO() store.ProjectReader       { return s.project }
func (s inspectionSnapshot) SessionDAO() store.SessionReader       { return s.session }

type inspectionSourceReader struct {
	store.SessionReader
	read func(context.Context, string, string, string) (store.TaskSessionSource, error)
}

func (r inspectionSourceReader) TaskSessionInspectionSource(ctx context.Context, p, t, s string) (store.TaskSessionSource, error) {
	return r.read(ctx, p, t, s)
}

type inspectionObserver func(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error)

func (f inspectionObserver) InspectTaskSession(ctx context.Context, p model.Principal, s store.TaskSessionSource) (sp.TaskSessionInspection, error) {
	return f(ctx, p, s)
}

type inspectionCredential struct{ store.CredentialReader }
type inspectionProject struct{ store.ProjectReader }

type inspectionBoundProject struct {
	store.ProjectReader
	access func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (r inspectionBoundProject) ProjectAccess(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	return r.access(ctx, p, project)
}

func TestInspectionConstructorBindsProjectRead(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	actor := model.Principal{Kind: model.OAuthCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
	cause := errors.New("bound project lookup failed")
	for _, test := range []struct {
		name    string
		failure error
	}{{"success", nil}, {"lookup failure", cause}} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			calls := 0
			reader := inspectionBoundProject{access: func(got context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
				calls++
				if calls != 1 || got != ctx || p != actor || id != project {
					t.Fatal("constructor-bound project lookup changed its inputs or call count")
				}
				return model.ProjectAccess{ProjectID: project, UserID: actor.UserID, Role: model.ProjectAdmin}, test.failure
			}}
			service := NewInspection(nil, nil)
			if err := service.projectRead(ctx, reader, actor, project); !errors.Is(err, test.failure) || calls != 1 {
				t.Fatalf("bound project lookup: calls=%d error=%v want %v", calls, err, test.failure)
			}
		})
	}
}

func TestInspectionUsesAuthorizedSnapshotAndExactSession(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const session = "33333333-3333-4333-8333-333333333333"
	actor := model.Principal{Kind: model.OAuthCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
	source := store.TaskSessionSource{ProjectID: project, TaskID: task, TaskVersion: 8, Session: &store.TaskSessionStateSource{SessionID: session}}
	expected := sp.TaskSessionInspection{SchemaVersion: 1, ProjectID: project, TaskID: task, SessionID: session, CurrentBinding: false, Source: "archive"}
	for _, failure := range []string{"", "credential", "project", "source", "observer", "snapshot"} {
		t.Run(failure, func(t *testing.T) {
			ctx := t.Context()
			cause := errors.New("inspection dependency failure")
			calls := []string{}
			credential, projects := &inspectionCredential{}, &inspectionProject{}
			reader := inspectionSourceReader{read: func(got context.Context, p, ta, se string) (store.TaskSessionSource, error) {
				calls = append(calls, "source")
				if got != ctx || p != project || ta != task || se != session {
					t.Fatal("source target/context changed")
				}
				if failure == "source" {
					return store.TaskSessionSource{}, cause
				}
				return source, nil
			}}
			database := &inspectionStore{scope: inspectionSnapshot{credential: credential, project: projects, session: reader}}
			if failure == "snapshot" {
				database.err = cause
			}
			observer := inspectionObserver(func(got context.Context, p model.Principal, s store.TaskSessionSource) (sp.TaskSessionInspection, error) {
				calls = append(calls, "observer")
				if got != ctx || p != actor || !reflect.DeepEqual(s, source) {
					t.Fatal("observer source/actor/context changed")
				}
				if failure == "observer" {
					return sp.TaskSessionInspection{}, cause
				}
				return expected, nil
			})
			service := NewInspection(database, observer)
			service.authorize = func(got context.Context, r store.CredentialReader, p model.Principal) error {
				calls = append(calls, "credential")
				if got != ctx || r != credential || p != actor {
					t.Fatal("credential scope changed")
				}
				if failure == "credential" {
					return cause
				}
				return nil
			}
			service.projectRead = func(got context.Context, r store.ProjectReader, p model.Principal, id string) error {
				calls = append(calls, "project")
				if got != ctx || r != projects || p != actor || id != project {
					t.Fatal("project scope changed")
				}
				if failure == "project" {
					return cause
				}
				return nil
			}
			got, err := service.Inspect(ctx, actor, project, task, session)
			if failure == "" {
				if err != nil || !reflect.DeepEqual(got, expected) {
					t.Fatalf("inspection: %#v %v", got, err)
				}
			} else if !errors.Is(err, cause) || got.SessionID != "" {
				t.Fatalf("failed snapshot published inspection: %#v %v", got, err)
			}
			want := []string{"credential", "project", "source", "observer", "credential", "project", "source"}
			if failure == "snapshot" {
				want = want[:3]
			}
			for i, name := range want {
				if name == failure {
					want = want[:i+1]
					break
				}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("calls %v want %v", calls, want)
			}
		})
	}
}

func inspectionRecheckFacts() (store.TaskSessionSource, sp.TaskSessionInspection) {
	project, task, id := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	claim, native, generation, epoch := "66666666-6666-4666-8666-666666666666", "native-original", "3", "4"
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: generation}, ConnectionEpoch: epoch}
	source := store.TaskSessionSource{ProjectID: project, TaskID: task, TaskVersion: 8, TaskStatus: model.TaskInProgress, Worker: &model.WorkerClaim{ClaimID: claim, State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}, Session: &store.TaskSessionStateSource{ProjectID: project, TaskID: task, SessionID: id, ClaimID: claim, Backend: "web", Fence: fence, Lifecycle: "active", Identity: sp.Identity{NativeSessionID: &native}}}
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	source.Session.LastSeen = &now
	allowed, start, idle, connected, active, warning := true, "start", "idle", "connected", "active", "warning"
	result := sp.TaskSessionInspection{SchemaVersion: 1, ProjectID: project, TaskID: task, SessionID: id, CurrentBinding: true, Fence: fence, Source: "live", Session: sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "registered", SessionID: &id, ClaimID: &claim, NativeSessionID: &native, ExecutionGeneration: &generation, ConnectionEpoch: &epoch, Activity: &idle, ConnectionState: &connected, Lifecycle: &active, Indicator: &warning, ObservedAt: &now, FreshUntil: &now, Send: sp.TaskSessionSend{Allowed: &allowed, Mode: &start, Reason: "allowed"}}}
	return source, result
}

func TestInspectionRechecksAfterReleasedSelection(t *testing.T) {
	changes := []struct {
		name               string
		change             func(*store.TaskSessionSource)
		missing, unchanged bool
	}{
		{name: "unchanged", unchanged: true},
		{name: "task version", change: func(s *store.TaskSessionSource) { s.TaskVersion++ }},
		{name: "task completed", change: func(s *store.TaskSessionSource) { s.TaskStatus = model.TaskDone }},
		{name: "new claim", change: func(s *store.TaskSessionSource) { s.Worker.ClaimID = "77777777-7777-4777-8777-777777777777" }},
		{name: "worker completed", change: func(s *store.TaskSessionSource) { s.Worker.State = model.WorkerCompleted }},
		{name: "worker removed", change: func(s *store.TaskSessionSource) { s.Worker = nil }},
		{name: "session draining", change: func(s *store.TaskSessionSource) { s.Session.Lifecycle = "draining" }},
		{name: "session fence", change: func(s *store.TaskSessionSource) { s.Session.Fence.ExecutionGeneration = "9" }},
		{name: "session owner", change: func(s *store.TaskSessionSource) { s.Session.OwnerID = "77777777-7777-4777-8777-777777777777" }},
		{name: "connection expired", change: func(s *store.TaskSessionSource) { at := time.Now(); s.Session.ConnectionExpiry = &at }},
		{name: "session missing", missing: true},
		{name: "heartbeat cleared", change: func(s *store.TaskSessionSource) { s.Session.LastSeen = nil }},
		{name: "heartbeat regressed", change: func(s *store.TaskSessionSource) { at := s.Session.LastSeen.Add(-time.Second); s.Session.LastSeen = &at }},
		{name: "heartbeat only", change: func(s *store.TaskSessionSource) { at := s.Session.LastSeen.Add(time.Second); s.Session.LastSeen = &at }, unchanged: true},
	}
	for _, test := range changes {
		t.Run(test.name, func(t *testing.T) {
			selected, sampled := inspectionRecheckFacts()
			current := selected
			worker, session := *selected.Worker, *selected.Session
			current.Worker, current.Session = &worker, &session
			actor := model.Principal{Kind: model.OAuthCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			selectedRead, committed := make(chan struct{}), make(chan struct{})
			active, observerCalls, authorizationCalls, sourceReads := false, 0, 0, 0
			database := &inspectionStore{}
			database.read = func(got context.Context, work func(store.SnapshotScope) error) error {
				if got != ctx || active || database.calls > 2 {
					t.Error("snapshot context, lifetime or call count changed")
				}
				active = true
				defer func() { active = false }()
				return work(inspectionSnapshot{session: inspectionSourceReader{read: func(got context.Context, p, ta, id string) (store.TaskSessionSource, error) {
					sourceReads++
					if got != ctx || p != selected.ProjectID || ta != selected.TaskID || id != selected.Session.SessionID {
						t.Error("recheck replaced the explicit original target")
					}
					if database.calls == 1 {
						close(selectedRead)
						return selected, nil
					}
					if observerCalls != 1 {
						t.Error("recheck ran before sampling")
					}
					if test.missing {
						return store.TaskSessionSource{}, model.ErrNotFound
					}
					return current, nil
				}}})
			}
			service := NewInspection(database, inspectionObserver(func(got context.Context, p model.Principal, source store.TaskSessionSource) (sp.TaskSessionInspection, error) {
				observerCalls++
				if got != ctx || p != actor || !reflect.DeepEqual(source, selected) {
					t.Error("selected sampling facts changed")
				}
				select {
				case <-committed:
				case <-ctx.Done():
					return sp.TaskSessionInspection{}, ctx.Err()
				}
				if active {
					t.Error("live sampling retained the selection snapshot")
				}
				return sampled, nil
			}))
			service.authorize = func(context.Context, store.CredentialReader, model.Principal) error { authorizationCalls++; return nil }
			service.projectRead = func(context.Context, store.ProjectReader, model.Principal, string) error { return nil }
			type outcome struct {
				result sp.TaskSessionInspection
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				result, err := service.Inspect(ctx, actor, selected.ProjectID, selected.TaskID, selected.Session.SessionID)
				done <- outcome{result, err}
			}()
			select {
			case <-selectedRead:
			case <-ctx.Done():
				t.Fatal("selection did not start")
			}
			if test.change != nil {
				test.change(&current)
			}
			close(committed)
			var result outcome
			select {
			case result = <-done:
			case <-ctx.Done():
				t.Fatal("inspection did not finish")
			}
			if result.err != nil {
				t.Fatal(result.err)
			}
			got := result.result
			if database.calls != 2 || authorizationCalls != 2 || sourceReads != 2 || observerCalls != 1 {
				t.Errorf("snapshot=%d credential=%d source=%d observer=%d", database.calls, authorizationCalls, sourceReads, observerCalls)
			}
			if test.unchanged {
				if !reflect.DeepEqual(got, sampled) {
					t.Fatalf("stable inspection changed: %#v", got)
				}
				return
			}
			if got.CurrentBinding || got.Source != "unavailable" || got.Session.Observation != "unavailable" || got.Session.Reason != "execution_changed" || got.Session.Send.Allowed != nil || got.Session.Send.Mode != nil || got.Session.FreshUntil != nil || got.Session.Activity != nil || got.Session.CurrentTurnID != nil || got.Session.Error == nil || got.Session.Error.Code != "execution_changed" {
				t.Fatalf("changed execution published sampled facts: %#v", got)
			}
			if got.Fence != sampled.Fence || got.SessionID != sampled.SessionID || got.Session.SessionID == nil || *got.Session.SessionID != sampled.SessionID || got.Session.ClaimID == nil || *got.Session.ClaimID != sampled.Fence.ClaimID || got.Session.ExecutionGeneration == nil || *got.Session.ExecutionGeneration != sampled.Fence.ExecutionGeneration || got.Session.ConnectionEpoch == nil || *got.Session.ConnectionEpoch != sampled.Fence.ConnectionEpoch {
				t.Fatalf("recheck replaced original identity: %#v", got)
			}
		})
	}
}

func TestInspectionFreshReadFailureSuppressesSampledResult(t *testing.T) {
	for _, failure := range []string{"credential", "project", "source", "snapshot start", "snapshot completion"} {
		t.Run(failure, func(t *testing.T) {
			selected, sampled := inspectionRecheckFacts()
			actor := model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
			cause := errors.New("fresh inspection read failed")
			calls := []string{}
			database := &inspectionStore{}
			database.read = func(ctx context.Context, work func(store.SnapshotScope) error) error {
				fresh := database.calls == 2
				if fresh {
					calls = append(calls, "snapshot start")
					if failure == "snapshot start" {
						return cause
					}
				}
				err := work(inspectionSnapshot{session: inspectionSourceReader{read: func(context.Context, string, string, string) (store.TaskSessionSource, error) {
					if fresh {
						calls = append(calls, "source")
						if failure == "source" {
							return store.TaskSessionSource{}, cause
						}
					}
					return selected, nil
				}}})
				if err != nil {
					return err
				}
				if fresh {
					calls = append(calls, "snapshot completion")
					if failure == "snapshot completion" {
						return cause
					}
				}
				return nil
			}
			service := NewInspection(database, inspectionObserver(func(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error) {
				calls = append(calls, "observer")
				return sampled, nil
			}))
			service.authorize = func(context.Context, store.CredentialReader, model.Principal) error {
				if database.calls == 2 {
					calls = append(calls, "credential")
					if failure == "credential" {
						return &model.Fault{Code: "unauthenticated", Message: "Credential revoked.", Cause: cause}
					}
				}
				return nil
			}
			service.projectRead = func(context.Context, store.ProjectReader, model.Principal, string) error {
				if database.calls == 2 {
					calls = append(calls, "project")
					if failure == "project" {
						return &model.Fault{Code: "forbidden", Message: "Project membership revoked.", Cause: cause}
					}
				}
				return nil
			}
			got, err := service.Inspect(t.Context(), actor, selected.ProjectID, selected.TaskID, selected.Session.SessionID)
			if !errors.Is(err, cause) || !reflect.DeepEqual(got, sp.TaskSessionInspection{}) {
				t.Errorf("fresh failure leaked sample: %#v %v", got, err)
			}
			want := []string{"observer", "snapshot start", "credential", "project", "source", "snapshot completion"}
			for i, name := range want {
				if name == failure {
					want = want[:i+1]
					break
				}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("calls %v want %v", calls, want)
			}
		})
	}
}

func TestInspectionRejectsInvalidScopeBeforeReading(t *testing.T) {
	database := &inspectionStore{}
	service := NewInspection(database, inspectionObserver(func(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error) {
		t.Fatal("observer invoked")
		return sp.TaskSessionInspection{}, nil
	}))
	actor := model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
	if _, err := service.Inspect(t.Context(), model.Principal{}, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"); err == nil {
		t.Fatal("invalid principal accepted")
	}
	for _, ids := range [][3]string{{"bad", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"}, {"11111111-1111-4111-8111-111111111111", "bad", "33333333-3333-4333-8333-333333333333"}, {"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "bad"}} {
		if _, err := service.Inspect(t.Context(), actor, ids[0], ids[1], ids[2]); err == nil {
			t.Fatal("invalid scope accepted")
		}
	}
	if database.calls != 0 {
		t.Fatal("invalid scope reached snapshot")
	}
}

func TestInspectionMapsMissingSourceAndPropagatesCancellation(t *testing.T) {
	const project, task, session = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	p := model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{true: "not found", false: "cancellation"}[missing], func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			started := make(chan struct{})
			database := &inspectionStore{scope: inspectionSnapshot{session: inspectionSourceReader{read: func(got context.Context, _, _, _ string) (store.TaskSessionSource, error) {
				if got != ctx {
					t.Fatal("source context changed")
				}
				if missing {
					return store.TaskSessionSource{}, model.ErrNotFound
				}
				close(started)
				<-got.Done()
				return store.TaskSessionSource{}, got.Err()
			}}}}
			service := NewInspection(database, inspectionObserver(func(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error) {
				t.Error("observer called after source failure")
				return sp.TaskSessionInspection{}, errors.New("unexpected observer")
			}))
			service.authorize = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
			service.projectRead = func(context.Context, store.ProjectReader, model.Principal, string) error { return nil }
			result := make(chan error, 1)
			go func() { _, err := service.Inspect(ctx, p, project, task, session); result <- err }()
			if !missing {
				<-started
				cancel()
			}
			err := <-result
			if missing {
				var failure *model.Fault
				if !errors.As(err, &failure) || failure.Code != "not_found" || !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing source: %v", err)
				}
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel: %v", err)
			}
		})
	}
}
