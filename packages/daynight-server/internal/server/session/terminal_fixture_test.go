package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type terminalRouteRecording struct {
	Responsibility  *v2.RecordingResponsibility
	Evidence        *v2.RecordingEvidence
	ObservedContent bool
}

type terminalRouteRecord struct {
	Envelope                                    v2.Envelope
	Registration                                v2.Registration
	RegistrationDigest, RegistrationEpoch       string
	Owner                                       v2.Owner
	Binding                                     v2.Binding
	Runs                                        []v2.Run
	FinalizationID                              *string
	ConnectionEpoch, ChannelEpoch, ControlEpoch string
	Control                                     *v2.ControlState
	ControlActor                                *model.Principal
	LastLeaseSeq                                string
	OperationSeq                                int64
	LastFrame                                   json.RawMessage
	LastSeen                                    *time.Time
	ServerInstance                              string
	Recording                                   map[string]terminalRouteRecording
	AutomationRecoveries                        json.RawMessage
}

type terminalRouteEvidence struct {
	Generation         int64
	ID, Hash, Revision string
}
type terminalRouteInput struct {
	ProjectMissing                                 bool
	Project, Task, Session                         string
	TaskState                                      store.SessionTask
	Deleted                                        bool
	Registration                                   v2.Registration
	Found, Current                                 string
	Credentials                                    []model.Principal
	Access                                         []model.ProjectAccess
	Raw                                            []byte
	Archive                                        store.ArchiveMetadata
	Status                                         v2.ArchiveStatus
	Receipt                                        *v2.Receipt
	Path                                           string
	Evidence                                       []terminalRouteEvidence
	History                                        []store.TerminalHistoryRow
	Operation                                      *store.TerminalOperation
	Queued                                         []string
	InputPending, ViewerPending, AutomationAllowed bool
}

type terminalRouteWrites struct {
	savedScopes     []*routeCallScope
	operationScopes []*routeCallScope
	resultScopes    []*routeCallScope
	epochScopes     []*routeCallScope
	evidenceScopes  []*routeCallScope
	insert          []store.TerminalRegistration
	saved           [][]byte
	operations      []store.TerminalOperation
	results         []v2.OperationResult
	epochs          []int64
	evidence        []terminalRouteEvidence
	statuses        []v2.ArchiveStatus
	receipts        []v2.Receipt
	paths           []*string
	invalidate      int
	viewerQueries   int
	changed         chan struct{}
}

type terminalInsertBarrier struct {
	entered          chan store.TerminalRegistration
	release          chan struct{}
	completed        chan store.Completion
	returnCompletion chan struct{}
}

type terminalDispatchBarrier struct {
	completed chan terminalPublicationOutcome
	release   chan struct{}
}

type terminalFixtureState struct {
	messageGate     *terminalMessageGate
	mu              sync.Mutex
	input           terminalRouteInput
	writes          terminalRouteWrites
	insertBarrier   *terminalInsertBarrier
	dispatchBarrier *terminalDispatchBarrier
	socketExpected  map[string]int
}

func (f *terminalHTTPFixture) configureTerminalBackend(t *testing.T) {
	t.Helper()
	f.state = &terminalFixtureState{writes: terminalRouteWrites{changed: make(chan struct{})}, socketExpected: map[string]int{}}
	t.Cleanup(func() { f.assertSocketContracts(t) })
	reg := f.message.Payload.(v2.Registration)
	owner := f.h.principal
	f.state.input = terminalRouteInput{
		Project: reg.Owner.ProjectID, Task: reg.Owner.TaskID, Session: f.message.SessionID,
		TaskState:    store.SessionTask{Status: "in_progress", Worker: &model.WorkerClaim{ClaimID: f.message.ClaimID, UserID: owner.UserID, WorkerID: reg.Owner.WorkerID, WorktreeID: reg.Owner.WorktreeID, State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, Platform: model.PlatformLinux}},
		Registration: reg, Credentials: []model.Principal{owner},
		Access:  []model.ProjectAccess{{ProjectID: reg.Owner.ProjectID, UserID: owner.UserID, Role: model.ProjectAdmin}},
		Archive: store.ArchiveMetadata{Owner: owner.UserID, Project: reg.Owner.ProjectID, Task: reg.Owner.TaskID, Backend: "herdr", TaskExists: true, ProjectLive: true, BotValid: true},
		Status:  v2.ArchiveStatus{State: "pending"},
	}
	f.backend.Configure(func(d *routeDAO) {
		d.LockCredentialFn = terminalRouteCredential
		d.ReadCredentialFn = terminalRouteCredential
		d.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			for _, value := range in.Access {
				if value.UserID == user && value.ProjectID == project {
					return value, nil
				}
			}
			return model.ProjectAccess{}, model.ErrNotFound
		}
		d.LockTaskFn = func(ctx context.Context, project, task string) (store.SessionTask, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if in.ProjectMissing {
				return store.SessionTask{}, model.ErrNotFound
			}
			if project != in.Project || task != in.Task || in.Deleted {
				return store.SessionTask{}, model.ErrNotFound
			}
			return in.TaskState, nil
		}
		d.LockArchiveTaskFn = func(ctx context.Context, project, task string) (store.SessionTask, bool, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if in.ProjectMissing {
				return store.SessionTask{}, false, model.ErrNotFound
			}
			if project != in.Project || task != in.Task {
				return store.SessionTask{}, false, model.ErrNotFound
			}
			return in.TaskState, in.Deleted, nil
		}
		d.LockTaskRegistrationFn = func(ctx context.Context, project, task string) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if project != in.Project || task != in.Task {
				return model.ErrNotFound
			}
			return nil
		}
		d.FindTerminalRegistrationFn = func(ctx context.Context, id, project, registration, task, claim string) (string, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || project != in.Project || task != in.Task || registration != in.Registration.RegistrationID || claim != in.TaskState.Worker.ClaimID {
				return "", model.ErrNotFound
			}
			if in.Found == "" {
				return "", model.ErrNotFound
			}
			return in.Found, nil
		}
		d.InsertTerminalFn = func(ctx context.Context, value store.TerminalRegistration) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if value.SessionID != in.Session || value.ProjectID != in.Project || value.TaskID != in.Task || value.OwnerID != in.Registration.Owner.OwnerUserID || value.ClaimID != in.TaskState.Worker.ClaimID || value.RegistrationID != in.Registration.RegistrationID || !bytes.Equal(value.Registration, []byte(jsonBody(t, in.Registration))) {
				return fmt.Errorf("terminal registration proposal changed its owner, scope or body")
			}
			f.state.mu.Lock()
			f.state.writes.insert = append(f.state.writes.insert, routeCopy(value))
			barrier := f.state.insertBarrier
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			if barrier != nil {
				select {
				case barrier.entered <- routeCopy(value):
				case <-ctx.Done():
					return ctx.Err()
				}
				select {
				case <-barrier.release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		}
		d.LockTerminalFn = func(ctx context.Context, id string) ([]byte, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || len(in.Raw) == 0 {
				return nil, model.ErrNotFound
			}
			return in.Raw, nil
		}
		d.SaveTerminalFn = func(ctx context.Context, id string, raw []byte, seen *time.Time, instance string) error {
			in := routeInputFor[terminalRouteInput](ctx)
			var record terminalRouteRecord
			if err := json.Unmarshal(raw, &record); err != nil {
				return err
			}
			if id != in.Session || record.Envelope.SessionID != id || record.Owner.ProjectID != in.Project || record.Owner.TaskID != in.Task || record.ServerInstance != instance || !terminalRouteTimesEqual(record.LastSeen, seen) {
				return fmt.Errorf("terminal save proposal changed its identity or metadata")
			}
			f.state.mu.Lock()
			f.state.writes.saved = append(f.state.writes.saved, append([]byte(nil), raw...))
			f.state.writes.savedScopes = append(f.state.writes.savedScopes, routeScopeToken(ctx))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.CurrentTerminalSessionFn = func(ctx context.Context, project, task, claim string) (string, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if project != in.Project || task != in.Task || claim != in.TaskState.Worker.ClaimID || in.Current == "" {
				return "", model.ErrNotFound
			}
			return in.Current, nil
		}
		d.TerminalArchiveFn = func(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return v2.ArchiveStatus{}, nil, "", model.ErrNotFound
			}
			return in.Status, in.Receipt, in.Path, nil
		}
		d.ArchiveMetadataFn = func(ctx context.Context, id string) (store.ArchiveMetadata, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return store.ArchiveMetadata{}, model.ErrNotFound
			}
			return in.Archive, nil
		}
		d.SaveTerminalReceiptFn = func(ctx context.Context, id string, value v2.Receipt, path *string) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return model.ErrNotFound
			}
			f.state.mu.Lock()
			f.state.writes.receipts = append(f.state.writes.receipts, routeCopy(value))
			f.state.writes.paths = append(f.state.writes.paths, routeCopy(path))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.SaveTerminalArchiveStatusFn = func(ctx context.Context, id string, value v2.ArchiveStatus) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return model.ErrNotFound
			}
			f.state.mu.Lock()
			f.state.writes.statuses = append(f.state.writes.statuses, routeCopy(value))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.TerminalHistoryFn = func(ctx context.Context, project, task string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if project != in.Project || task != in.Task || before != nil || beforeID != nil || limit < 2 {
				return nil, fmt.Errorf("terminal history arguments changed")
			}
			return in.History, nil
		}
		d.TerminalRecordingEvidenceFn = func(ctx context.Context, id string, generation int64, evidence string) (string, string, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return "", "", model.ErrNotFound
			}
			for _, value := range in.Evidence {
				if value.Generation == generation && value.ID == evidence {
					return value.Hash, value.Revision, nil
				}
			}
			return "", "", model.ErrNotFound
		}
		d.InsertRecordingEvidenceFn = func(ctx context.Context, id string, generation int64, evidence string, revision int64, hash string) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || generation < 1 || evidence == "" || revision < 1 || hash == "" {
				return fmt.Errorf("recording evidence write arguments changed")
			}
			f.state.mu.Lock()
			f.state.writes.evidence = append(f.state.writes.evidence, terminalRouteEvidence{Generation: generation, ID: evidence, Revision: strconv.FormatInt(revision, 10), Hash: hash})
			f.state.writes.evidenceScopes = append(f.state.writes.evidenceScopes, routeScopeToken(ctx))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.TerminalOperationFn = func(ctx context.Context, id, operation string) (store.TerminalOperation, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || in.Operation == nil || operation != in.Operation.OperationID {
				return store.TerminalOperation{}, model.ErrNotFound
			}
			return *in.Operation, nil
		}
		d.InsertTerminalOperationFn = func(ctx context.Context, value store.TerminalOperation) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if value.SessionID != in.Session || value.OperationID == "" || len(value.Command) == 0 || len(value.Hash) != 32 {
				return fmt.Errorf("terminal operation write lost its identity or digest")
			}
			f.state.mu.Lock()
			f.state.writes.operations = append(f.state.writes.operations, routeCopy(value))
			f.state.writes.operationScopes = append(f.state.writes.operationScopes, routeScopeToken(ctx))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.SetTerminalOperationResultFn = func(ctx context.Context, id string, value v2.OperationResult) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || in.Operation == nil || value.OperationID != in.Operation.OperationID {
				return fmt.Errorf("terminal result targeted a different operation")
			}
			f.state.mu.Lock()
			f.state.writes.results = append(f.state.writes.results, routeCopy(value))
			f.state.writes.resultScopes = append(f.state.writes.resultScopes, routeScopeToken(ctx))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.SetSessionOperationEpochFn = func(ctx context.Context, id, operation string, epoch int64) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || in.Operation == nil || operation != in.Operation.OperationID || epoch < 1 {
				return fmt.Errorf("terminal dispatch epoch changed its operation")
			}
			f.state.mu.Lock()
			f.state.writes.epochs = append(f.state.writes.epochs, epoch)
			f.state.writes.epochScopes = append(f.state.writes.epochScopes, routeScopeToken(ctx))
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.InvalidateTerminalOperationsFn = func(ctx context.Context, id string) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return model.ErrNotFound
			}
			f.state.mu.Lock()
			f.state.writes.invalidate++
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return nil
		}
		d.ExpireTerminalOperationsFn = func(ctx context.Context, id string, now time.Time) error {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || now.IsZero() {
				return fmt.Errorf("terminal expiry check arguments changed")
			}
			return nil
		}
		d.QueuedTerminalOperationFn = func(ctx context.Context, id string) ([]string, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return nil, model.ErrNotFound
			}
			return in.Queued, nil
		}
		d.TerminalInputPendingFn = func(ctx context.Context, id string) (bool, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session {
				return false, model.ErrNotFound
			}
			return in.InputPending, nil
		}
		d.TerminalViewerOperationPendingFn = func(ctx context.Context, id, user, browser string) (bool, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if id != in.Session || user == "" || browser == "" {
				return false, fmt.Errorf("terminal viewer check arguments changed")
			}
			f.state.mu.Lock()
			f.state.writes.viewerQueries++
			f.signalTerminalWritesLocked()
			f.state.mu.Unlock()
			return in.ViewerPending, nil
		}
		d.TerminalAutomationAllowedFn = func(ctx context.Context, task string) (bool, error) {
			in := routeInputFor[terminalRouteInput](ctx)
			if task != in.Task {
				return false, model.ErrNotFound
			}
			return in.AutomationAllowed, nil
		}
	})
	f.declareTerminalContracts()
	f.installTerminalPublicationOutcomes()
	f.backend.Outcome("terminal-register", func(ctx context.Context, cause error) (store.Completion, error) {
		completion, result := f.backend.CompletionFn(ctx, cause)
		f.state.mu.Lock()
		barrier := f.state.insertBarrier
		f.state.mu.Unlock()
		if barrier != nil {
			select {
			case barrier.completed <- completion:
			case <-ctx.Done():
				return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
			}
			select {
			case <-barrier.returnCompletion:
			case <-ctx.Done():
				return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
			}
		}
		return completion, result
	})
	f.backend.Outcome("terminal-poll-dispatch", func(ctx context.Context, cause error) (store.Completion, error) {
		completion, result := f.backend.CompletionFn(ctx, cause)
		f.state.mu.Lock()
		barrier := f.state.dispatchBarrier
		f.state.mu.Unlock()
		if barrier == nil {
			t.Error("dispatch completed without its selected outcome barrier")
			return store.Completion{Outcome: store.TransactionNotCommitted}, fmt.Errorf("unconfigured terminal dispatch completion")
		}
		select {
		case barrier.completed <- terminalPublicationOutcome{scope: routeScopeToken(ctx), outcome: completion, err: result}:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
		select {
		case <-barrier.release:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
		return completion, result
	})
}

func terminalRouteCredential(ctx context.Context, p model.Principal, now time.Time) error {
	in := routeInputFor[terminalRouteInput](ctx)
	if now.IsZero() {
		return fmt.Errorf("credential check omitted its clock")
	}
	for _, expected := range in.Credentials {
		if p == expected {
			return nil
		}
	}
	return model.ErrNotFound
}

func terminalRouteTimesEqual(a, b *time.Time) bool {
	return a == nil && b == nil || a != nil && b != nil && a.Equal(*b)
}
func (f *terminalHTTPFixture) signalTerminalWritesLocked() {
	close(f.state.writes.changed)
	f.state.writes.changed = make(chan struct{})
}
func (f *terminalHTTPFixture) inputSnapshot() any {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	return routeCopy(f.state.input)
}
func (f *terminalHTTPFixture) input(update func(*terminalRouteInput)) {
	f.backend.mu.Lock()
	defer f.backend.mu.Unlock()
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	update(&f.state.input)
}

func (f *terminalHTTPFixture) declareTerminal(name string, work map[string]int, repeat bool) {
	f.backend.Declare(name, work, f.inputSnapshot, repeat)
}

func terminalRouteCounts(base map[string]int, work map[string]int) map[string]int {
	out := map[string]int{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range work {
		out[k] = v
	}
	return out
}
func terminalReadCounts(work map[string]int) map[string]int {
	return terminalRouteCounts(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, work)
}
func terminalArchiveCounts(work map[string]int) map[string]int {
	return terminalRouteCounts(map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, work)
}
func terminalRegistrationCounts(work map[string]int) map[string]int {
	return terminalRouteCounts(map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1}, work)
}

func (f *terminalHTTPFixture) declareTerminalContracts() {
	f.declareTerminal("terminal-register", terminalRegistrationCounts(map[string]int{"InsertTerminal": 1}), false)
	f.declareTerminal("terminal-register-existing", terminalRegistrationCounts(map[string]int{"LockTerminal": 1}), false)
	f.declareTerminal("terminal-reconnect", terminalRegistrationCounts(map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-bind", terminalReadCounts(map[string]int{"SaveTerminal": 1}), false)
	f.declareTerminal("terminal-bind-refused", terminalReadCounts(nil), false)
	f.declareTerminal("terminal-ledger", terminalArchiveCounts(map[string]int{"SaveTerminal": 1}), false)
	f.declareTerminal("terminal-generation", terminalArchiveCounts(map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-recording", terminalArchiveCounts(map[string]int{"SaveTerminal": 1}), false)
	f.declareTerminal("terminal-evidence", terminalArchiveCounts(map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-finalize", terminalArchiveCounts(map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-worker-initial", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-worker-state", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-worker-refused", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1}), false)
	f.declareTerminal("terminal-poll", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "QueuedTerminalOperation": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-poll-dispatch", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "QueuedTerminalOperation": 1, "TerminalOperation": 1, "SetSessionOperationEpoch": 1, "SetTerminalOperationResult": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-poll-lease", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "QueuedTerminalOperation": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-state", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}), false)
	f.declareTerminal("terminal-state-lease", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "TerminalArchive": 1}), false)
	f.declareTerminal("terminal-viewer-state", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}), true)
	f.declareTerminal("terminal-viewer-lease-state", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "TerminalArchive": 1}), true)
	f.declareTerminal("terminal-duplicate-viewer-lease-state", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "TerminalArchive": 1}), false)
	f.declareTerminal("terminal-viewer-forbidden", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, true)
	f.declareTerminal("terminal-routing", terminalReadCounts(nil), false)
	f.declareTerminal("terminal-archive-state", terminalArchiveCounts(map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}), false)
	f.declareTerminal("terminal-archive-status", terminalArchiveCounts(map[string]int{"TerminalArchive": 1}), false)
	f.declareTerminal("terminal-current", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTerminalSession": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1}, false)
	f.declareTerminal("terminal-current-routing", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTerminalSession": 1, "LockTerminal": 1}, false)
	f.declareTerminal("terminal-v1-current", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, false)
	f.declareTerminal("terminal-history", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1}, false)
	f.declareTerminal("terminal-operation", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "TerminalOperation": 1}), false)
	f.declareTerminal("terminal-operation-lease", terminalReadCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "ExpireTerminalOperations": 1, "TerminalOperation": 1}), false)
	f.declareTerminal("terminal-submit", terminalReadCounts(map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1, "TerminalInputPending": 1, "InsertTerminalOperation": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-ack", terminalArchiveCounts(map[string]int{"LockCredential": 2, "ProjectAccess": 2, "TerminalOperation": 1, "SetTerminalOperationResult": 1, "SaveTerminal": 1}), false)
	f.declareTerminal("terminal-evidence-read", terminalArchiveCounts(map[string]int{"TerminalRecordingEvidence": 1}), false)
	f.declareTerminal("terminal-recovery-read", terminalArchiveCounts(nil), false)
	f.declareTerminal("terminal-receipt", terminalArchiveCounts(map[string]int{"TerminalArchive": 1, "SaveTerminalReceipt": 1}), false)
	f.declareTerminal("terminal-upload-preflight", map[string]int{"ReadCredential": 1, "ProjectAccess": 1, "ArchiveMetadata": 1}, false)
	f.declareTerminal("terminal-upload", terminalArchiveCounts(map[string]int{"TerminalArchive": 1, "SaveTerminalReceipt": 1}), false)
	f.declareTerminal("terminal-upload-unfrozen", terminalArchiveCounts(nil), false)
	f.declareTerminal("terminal-read-content", terminalReadCounts(map[string]int{"TerminalArchive": 1}), false)
	f.declareTerminal("terminal-deleted-task", map[string]int{"LockTask": 1}, false)
	f.declareTerminal("terminal-forbidden", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, false)
	f.declareTerminal("terminal-forbidden-drain", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, true)
	f.declareTerminal("terminal-worker-drain", terminalArchiveCounts(map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2}), true)
	f.declareTerminal("terminal-worker-stale-drain", terminalArchiveCounts(nil), true)
	f.declareTerminal("terminal-viewer-drain", terminalReadCounts(map[string]int{"TerminalViewerOperationPending": 1}), true)
	f.declareTerminal("terminal-viewer-lease-drain", terminalReadCounts(map[string]int{"TerminalViewerOperationPending": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-viewer-stale-drain", terminalReadCounts(nil), true)
	f.declareTerminal("terminal-socket-initial", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-socket-state", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1, "SaveTerminal": 1}), true)
	f.declareTerminal("terminal-socket-refused", terminalReadCounts(map[string]int{"ExpireTerminalOperations": 1}), true)
	f.declareTerminal("terminal-socket-write", terminalArchiveCounts(map[string]int{"SaveTerminal": 1}), true)
	for _, name := range []string{"terminal-socket-initial", "terminal-socket-state", "terminal-socket-refused", "terminal-socket-write", "terminal-poll-dispatch"} {
		f.backend.ExpectUses(name, 0)
	}
	f.backend.Background("terminal-worker-drain", "terminal-worker-stale-drain", "terminal-viewer-drain", "terminal-viewer-lease-drain", "terminal-viewer-stale-drain", "terminal-forbidden-drain")
}

func (f *terminalHTTPFixture) workerHeaders(extra ...string) http.Header {
	names := []string{"terminal-register", "terminal-bind", "terminal-poll", "terminal-poll-lease", "terminal-poll-dispatch", "terminal-socket-initial", "terminal-socket-state", "terminal-socket-refused", "terminal-socket-write"}
	names = append(names, extra...)
	header := f.backend.PlanHeader(names...)
	header.Set("Authorization", "Bearer "+f.h.token)
	return header
}

func (f *terminalHTTPFixture) viewerHeaders(h *resourceTestHandler) http.Header {
	f.backend.Require("terminal-viewer-state", 1)
	header := f.backend.PlanHeader("terminal-viewer-state", "terminal-viewer-lease-state", "terminal-viewer-forbidden")
	header.Set("Authorization", "Bearer "+h.token)
	return header
}

func (f *terminalHTTPFixture) duplicateWorkerHeaders() http.Header {
	header := f.backend.PlanHeader("terminal-register-existing", "terminal-bind-refused")
	header.Set("Authorization", "Bearer "+f.h.token)
	return header
}

func (f *terminalHTTPFixture) duplicateViewerHeaders() http.Header {
	header := f.backend.PlanHeader("terminal-duplicate-viewer-lease-state")
	header.Set("Authorization", "Bearer "+f.h.token)
	return header
}

func (f *terminalHTTPFixture) expectSocketScope(name string, count int) {
	f.state.mu.Lock()
	f.state.socketExpected[name] += count
	expected := f.state.socketExpected[name]
	f.state.mu.Unlock()
	f.backend.ExpectUses(name, expected)
}

func (f *terminalHTTPFixture) assertSocketContracts(t *testing.T) {
	t.Helper()
	f.state.mu.Lock()
	expected := routeCopy(f.state.socketExpected)
	f.state.mu.Unlock()
	profiles := []string{"terminal-socket-initial", "terminal-socket-state", "terminal-socket-refused", "terminal-socket-write", "terminal-poll-dispatch"}
	f.backend.mu.Lock()
	plans := append([]*routePlan(nil), f.backend.plans...)
	f.backend.mu.Unlock()
	for _, name := range profiles {
		count := 0
		for _, plan := range plans {
			plan.mu.Lock()
			count += plan.used[name]
			plan.mu.Unlock()
		}
		if count != expected[name] {
			t.Errorf("terminal socket scope %s completed %d times, want exactly %d", name, count, expected[name])
		}
	}
}

func (f *terminalHTTPFixture) writeIndex() int {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	return len(f.state.writes.saved)
}
func terminalDecodeRecord(t *testing.T, raw []byte) terminalRouteRecord {
	t.Helper()
	var r terminalRouteRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}
func (f *terminalHTTPFixture) selectInsert(t *testing.T, in store.TerminalRegistration) {
	t.Helper()
	reg := f.message.Payload.(v2.Registration)
	if _, err := uuid.Parse(in.ServerInstance); err != nil || in.LastSeen.IsZero() || time.Since(in.LastSeen) < -time.Second || time.Since(in.LastSeen) > time.Minute {
		t.Fatal("registration runtime metadata is invalid", err)
	}
	seen := in.LastSeen
	expected := terminalRouteRecord{Envelope: f.message.Envelope, Registration: reg, RegistrationDigest: v2.HashBytes([]byte(jsonBody(t, f.message))), RegistrationEpoch: "1", Owner: reg.Owner, Binding: reg.Binding, Runs: []v2.Run{}, ConnectionEpoch: "1", ControlEpoch: "0", LastLeaseSeq: "0", LastSeen: &seen, ServerInstance: in.ServerInstance, Recording: map[string]terminalRouteRecording{}}
	raw := []byte(jsonBody(t, expected))
	terminalAssertRecordJSON(t, in.State, raw)
	f.input(func(next *terminalRouteInput) {
		next.Raw = raw
		next.Found = f.message.SessionID
		next.Current = f.message.SessionID
	})
}

func terminalAssertRecordJSON(t *testing.T, actual, expected []byte) {
	t.Helper()
	var a, b map[string]json.RawMessage
	if err := json.Unmarshal(actual, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("terminal proposal changed independently supplied semantic fields\nactual: %s\nexpected: %s", actual, expected)
	}
}

func terminalRecordJSONEqual(a, b []byte) bool {
	var av, bv map[string]json.RawMessage
	if err := json.Unmarshal(a, &av); err != nil {
		panic(err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		panic(err)
	}
	return reflect.DeepEqual(av, bv)
}

func terminalSuspend(r *terminalRouteRecord) {
	if r.Control != nil {
		if r.Control.State != "closing" && r.Control.State != "closed" {
			r.Control.State = "suspended"
		}
		r.Control.Lease = nil
		r.Control.AvailableActions = []string{}
		r.Control.ConnectionEpoch = r.ConnectionEpoch
	}
	r.ControlActor = nil
	r.LastLeaseSeq = "0"
}

func (f *terminalHTTPFixture) register(t *testing.T) v2.Message {
	t.Helper()
	f.input(func(in *terminalRouteInput) { in.Registration = f.message.Payload.(v2.Registration) })
	f.state.mu.Lock()
	before := len(f.state.writes.insert)
	f.state.mu.Unlock()
	ack := terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol, "terminal-register"))
	f.state.mu.Lock()
	inserted := routeCopy(f.state.writes.insert[before:])
	f.state.mu.Unlock()
	if len(inserted) != 1 || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "1" {
		t.Fatal("registration did not propose exactly one bound initial record", ack)
	}
	f.selectInsert(t, inserted[0])
	return ack
}

func (f *terminalHTTPFixture) reconnect(t *testing.T, message v2.Message) v2.Message {
	t.Helper()
	projection := terminalMessageProjection(t, f.inputSnapshot().(terminalRouteInput), message)
	request := httptest.NewRequest(http.MethodPost, f.base, strings.NewReader(jsonBody(t, message)))
	authorizeResourceRequest(f.h, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(v2.ProtocolHeader, v2.Protocol)
	ack := terminalMessage(t, f.projectedHTTPRequest(t, request, "terminal-reconnect", projection))
	if ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal("reconnect did not advance one connection epoch", ack)
	}
	return ack
}

func mustTerminalNumber(t *testing.T, value string) int64 {
	t.Helper()
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 1 {
		t.Fatal("invalid supplied terminal number", value, err)
	}
	return number
}

func (f *terminalHTTPFixture) workerMessage(t *testing.T, worker *websocket.Conn, message v2.Message, scope string) map[string]json.RawMessage {
	t.Helper()
	f.backend.mu.Lock()
	contract := f.backend.contracts[scope]
	if contract == nil {
		f.backend.mu.Unlock()
		t.Fatal("unknown terminal message scope", scope)
	}
	saves := contract.calls["SaveTerminal"]
	f.backend.mu.Unlock()
	var gate *terminalMessageGate
	if saves != 0 {
		projection := terminalMessageProjection(t, f.inputSnapshot().(terminalRouteInput), message)
		gate = f.beginPublication(t, scope, projection)
	}
	f.expectSocketScope(scope, 1)
	sessionWSWrite(t, worker, message)
	if gate != nil {
		f.finishPublication(t, gate, nil)
	}
	return sessionWSKind(t, worker, message.Type)
}

func (f *terminalHTTPFixture) awaitSaved(t *testing.T, index int, check func(terminalRouteRecord) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		f.state.mu.Lock()
		for _, raw := range f.state.writes.saved[index:] {
			var r terminalRouteRecord
			if err := json.Unmarshal(raw, &r); err != nil {
				f.state.mu.Unlock()
				t.Fatal(err)
			}
			if check(r) {
				selected := append([]byte(nil), raw...)
				f.state.mu.Unlock()
				f.input(func(in *terminalRouteInput) { in.Raw = selected })
				return
			}
		}
		changed := f.state.writes.changed
		f.state.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("terminal completion proposal was not observed")
		}
	}
}

func (f *terminalHTTPFixture) handshake(t *testing.T, worker *websocket.Conn) {
	t.Helper()
	f.input(func(in *terminalRouteInput) { in.Registration = f.message.Payload.(v2.Registration) })
	barrier := &terminalInsertBarrier{entered: make(chan store.TerminalRegistration, 1), release: make(chan struct{}), completed: make(chan store.Completion, 1), returnCompletion: make(chan struct{})}
	f.state.mu.Lock()
	f.state.insertBarrier = barrier
	f.state.mu.Unlock()
	t.Cleanup(func() {
		select {
		case <-barrier.release:
		default:
			close(barrier.release)
		}
		select {
		case <-barrier.returnCompletion:
		default:
			close(barrier.returnCompletion)
		}
	})
	sessionWSWrite(t, worker, f.message)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var inserted store.TerminalRegistration
	select {
	case inserted = <-barrier.entered:
	case <-ctx.Done():
		t.Fatal("worker registration proposal was not observed")
	}
	close(barrier.release)
	select {
	case completion := <-barrier.completed:
		if completion.Outcome != store.TransactionCommitted {
			t.Fatal("worker registration did not confirm commit", completion)
		}
		f.selectInsert(t, inserted)
	case <-ctx.Done():
		t.Fatal("registration completion was not observed")
	}
	bindRecord := terminalDecodeRecord(t, f.inputSnapshot().(terminalRouteInput).Raw)
	bindRecord.ChannelEpoch = "1"
	bindGate := f.beginPublication(t, "terminal-bind", terminalProjection{Record: &bindRecord})
	close(barrier.returnCompletion)
	f.state.mu.Lock()
	f.state.insertBarrier = nil
	f.state.mu.Unlock()
	f.finishPublication(t, bindGate, nil)
	ack := sessionWSKind(t, worker, "registration_ack")
	var payload v2.RegistrationAck
	if err := json.Unmarshal(ack["payload"], &payload); err != nil || payload.ConnectionEpoch != "1" {
		t.Fatal("worker did not ACK the declared bind scope", err)
	}
}

func (f *terminalHTTPFixture) selectReceipt(t *testing.T, receipt v2.Receipt, data []byte) {
	t.Helper()
	f.state.mu.Lock()
	receipts := routeCopy(f.state.writes.receipts)
	paths := routeCopy(f.state.writes.paths)
	f.state.mu.Unlock()
	if len(receipts) == 0 || !reflect.DeepEqual(receipts[len(receipts)-1], receipt) {
		t.Fatal("archive receipt proposal changed its selected immutable value")
	}
	var expectedPath string
	status := v2.ArchiveStatus{State: receipt.Disposition, FinalizationID: &receipt.FinalizationID}
	if data != nil {
		hash, size := v2.HashBytes(data), strconv.Itoa(len(data))
		if receipt.Disposition != "ready" || receipt.SHA256 == nil || *receipt.SHA256 != hash || receipt.ByteLength == nil || *receipt.ByteLength != size || receipt.Completeness == nil {
			t.Fatal("ready receipt does not describe the exact supplied bytes")
		}
		owner := f.message.Payload.(v2.Registration).Owner
		namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, owner.ProjectID, f.message.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		expectedPath, err = namespace.ObjectPath(hash)
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) == 0 || paths[len(paths)-1] == nil || *paths[len(paths)-1] != expectedPath {
			t.Fatal("ready receipt changed its original project-owned object address")
		}
		status.SHA256 = &hash
		status.ByteLength = &size
		status.Completeness = receipt.Completeness
	} else if receipt.Disposition != "unavailable" || len(paths) == 0 || paths[len(paths)-1] != nil {
		t.Fatal("unavailable receipt unexpectedly published an object")
	}
	f.input(func(in *terminalRouteInput) {
		in.Status = status
		copy := receipt
		in.Receipt = &copy
		in.Path = expectedPath
	})
}

func (f *terminalHTTPFixture) prepareDispatch(t *testing.T, operation string) {
	t.Helper()
	barrier := &terminalDispatchBarrier{completed: make(chan terminalPublicationOutcome, 1), release: make(chan struct{})}
	f.state.mu.Lock()
	if f.state.dispatchBarrier != nil {
		f.state.mu.Unlock()
		t.Fatal("another terminal dispatch completion is selected")
	}
	f.state.dispatchBarrier = barrier
	f.state.mu.Unlock()
	t.Cleanup(func() {
		select {
		case <-barrier.release:
		default:
			close(barrier.release)
		}
	})
	f.expectSocketScope("terminal-poll-dispatch", 1)
}

// Dispatch completion precedes socket delivery. Select the post-dispatch facts
// before another timer poll, including when the client delays reading its offer.
func (f *terminalHTTPFixture) releaseDispatch(t *testing.T, request v2.ControlRequest) {
	t.Helper()
	f.state.mu.Lock()
	barrier := f.state.dispatchBarrier
	f.state.mu.Unlock()
	if barrier == nil {
		t.Fatal("control request has no selected dispatch completion")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var completed terminalPublicationOutcome
	select {
	case completed = <-barrier.completed:
		if completed.outcome.Outcome != store.TransactionCommitted || completed.err != nil {
			t.Fatal("terminal dispatch did not confirm commit", completed.outcome, completed.err)
		}
	case <-ctx.Done():
		t.Fatal("terminal dispatch completion was not observed")
	}
	writes := f.publicationWrites(completed.scope)
	f.state.mu.Lock()
	base := append([]byte(nil), f.state.input.Raw...)
	f.state.mu.Unlock()
	epochs, results, saved := writes.epochs, writes.results, writes.saved
	expected := v2.OperationResult{OperationID: request.OperationID, State: "dispatching"}
	if len(epochs) != 1 || epochs[0] != 1 || len(results) != 1 || !reflect.DeepEqual(results[0], expected) {
		t.Fatal("dispatch did not propose the selected epoch and receipt")
	}
	if len(saved) != 1 {
		t.Fatal("dispatch did not propose exactly one terminal heartbeat")
	}
	heartbeat := terminalDecodeRecord(t, saved[0])
	if heartbeat.LastSeen == nil || time.Since(*heartbeat.LastSeen) < -time.Second || time.Since(*heartbeat.LastSeen) > time.Minute {
		t.Fatal("dispatch heartbeat did not retain its runtime timestamp")
	}
	nextRecord := terminalDecodeRecord(t, base)
	nextRecord.LastSeen = heartbeat.LastSeen
	nextRaw := []byte(jsonBody(t, nextRecord))
	terminalAssertRecordJSON(t, saved[0], nextRaw)
	f.input(func(in *terminalRouteInput) {
		if in.Operation == nil || in.Operation.OperationID != request.OperationID {
			panic("dispatch selected a different supplied operation")
		}
		value := *in.Operation
		epoch := int64(1)
		value.Epoch = &epoch
		value.Result = expected
		in.Operation = &value
		in.Queued = []string{}
		in.Raw = nextRaw
	})
	close(barrier.release)
	f.state.mu.Lock()
	f.state.dispatchBarrier = nil
	f.state.mu.Unlock()
}

func (f *terminalHTTPFixture) assertDispatch(t *testing.T, request v2.ControlRequest, payload v2.ControlDispatch) {
	t.Helper()
	digest, err := v2.ControlRequestDigest(f.h.principal.UserID, request)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(payload.Request, request) || payload.ActorUserID != f.h.principal.UserID || payload.RequestDigest != digest {
		t.Fatal("Worker dispatch changed the original actor or request")
	}
	f.state.mu.Lock()
	epochs := append([]int64(nil), f.state.writes.epochs...)
	results := routeCopy(f.state.writes.results)
	f.state.mu.Unlock()
	expected := v2.OperationResult{OperationID: request.OperationID, State: "dispatching"}
	if len(epochs) != 1 || epochs[0] != 1 || len(results) != 1 || !reflect.DeepEqual(results[0], expected) {
		t.Fatal("dispatch did not propose the current connection epoch and durable state")
	}
}

func (f *terminalHTTPFixture) waitConnections(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if got := f.app.(*routeApplication).Routes.ActiveConnections(); got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal routes did not drain to %d active connections", want)
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *terminalHTTPFixture) invalidations() int {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	return f.state.writes.invalidate
}
func (f *terminalHTTPFixture) viewerQueries() int {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	return f.state.writes.viewerQueries
}

func (f *terminalHTTPFixture) completeTask() {
	f.input(func(in *terminalRouteInput) {
		worker := *in.TaskState.Worker
		worker.State = model.WorkerCompleted
		in.TaskState.Worker = &worker
		in.TaskState.Status = "done"
	})
}
func (f *terminalHTTPFixture) deleteTask() {
	f.completeTask()
	f.input(func(in *terminalRouteInput) { in.Deleted = true; in.Archive.TaskDeleted = true })
}

func (f *terminalHTTPFixture) projectMissing() {
	f.input(func(in *terminalRouteInput) { in.ProjectMissing = true })
}
func (f *terminalHTTPFixture) addViewer(t *testing.T, role model.ProjectRole) *resourceTestHandler {
	t.Helper()
	p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	token := f.authentication.Credential(p)
	f.input(func(in *terminalRouteInput) {
		in.Credentials = append(in.Credentials, p)
		in.Access = append(in.Access, model.ProjectAccess{ProjectID: in.Project, UserID: p.UserID, Role: role})
	})
	return &resourceTestHandler{Handler: f.h.Handler, token: token, principal: p, backend: f.backend, authentication: f.authentication}
}
func (f *terminalHTTPFixture) revokeViewer(p model.Principal) {
	f.input(func(in *terminalRouteInput) {
		values := make([]model.ProjectAccess, 0, len(in.Access))
		for _, value := range in.Access {
			if value.UserID != p.UserID {
				values = append(values, value)
			}
		}
		in.Access = values
	})
}
