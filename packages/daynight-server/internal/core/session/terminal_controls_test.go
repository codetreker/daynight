package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTerminalLeaseTransitionRequiresTheRequestedActorAndBoundedExpiry(t *testing.T) {
	now := time.Date(2026, 11, 3, 13, 0, 0, 0, time.UTC)
	request := v2.ControlRequest{OperationID: "operation", ConnectionEpoch: "1", ControlEpoch: "4", Action: "acquire_control", BrowserClientID: "browser"}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "5", State: "manual", Lease: &v2.Lease{LeaseID: "lease", HolderUserID: "actor", BrowserClientID: "browser", ControlEpoch: "5", ExpiresAt: now.Add(30 * time.Second).Format(time.RFC3339)}}
	if err := terminalControlTransition(request, "actor", state, now); err != nil {
		t.Fatal(err)
	}
	state.Lease.HolderUserID = "other"
	if err := terminalControlTransition(request, "actor", state, now); err == nil {
		t.Fatal("a different user received the pending request's lease")
	}
	state.Lease.HolderUserID = "actor"
	state.Lease.ExpiresAt = now.Add(31 * time.Second).Format(time.RFC3339)
	if err := terminalControlTransition(request, "actor", state, now); err == nil {
		t.Fatal("an overlong lease was accepted")
	}
	state.Lease.ExpiresAt = now.Format(time.RFC3339)
	if err := terminalControlTransition(request, "actor", state, now); err == nil {
		t.Fatal("an expired lease was accepted")
	}
}

func TestTerminalControlReleaseCannotResumeAutomationAndRenewCannotReplaceLease(t *testing.T) {
	now := time.Date(2026, 11, 3, 13, 0, 0, 0, time.UTC)
	id := "original"
	request := v2.ControlRequest{Action: "release_control", ConnectionEpoch: "1", ControlEpoch: "4", LeaseID: &id, BrowserClientID: "browser"}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "5", State: "automation"}
	if terminalControlTransition(request, "actor", state, now) == nil {
		t.Fatal("ordinary release resumed automation")
	}
	state.State = "suspended"
	if err := terminalControlTransition(request, "actor", state, now); err != nil {
		t.Fatal(err)
	}
	request.Action = "renew_control"
	state.State = "manual"
	state.ControlEpoch = "4"
	state.Lease = &v2.Lease{LeaseID: id, HolderUserID: "actor", BrowserClientID: "browser", ControlEpoch: "4", ExpiresAt: now.Add(30 * time.Second).Format(time.RFC3339)}
	if err := terminalControlTransition(request, "actor", state, now); err != nil {
		t.Fatal(err)
	}
	state.Lease.LeaseID = "replacement"
	if terminalControlTransition(request, "actor", state, now) == nil {
		t.Fatal("renewal replaced original lease")
	}
}

func TestTerminalInitialDispositionAcknowledgementKeepsAutomationSuspended(t *testing.T) {
	now := time.Date(2026, 11, 3, 13, 0, 0, 0, time.UTC)
	disposition := "delivered_continue"
	request := v2.ControlRequest{Action: "resolve_initial_assignment", ConnectionEpoch: "1", ControlEpoch: "4", InitialUnknownDisposition: &disposition}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "5", State: "suspended", InitialAssignment: "transport_completed"}
	if err := terminalControlTransition(request, "actor", state, now); err != nil {
		t.Fatal(err)
	}
	if !terminalInitialProgress("unknown", "transport_completed", &request) || !terminalInitialProgress("unconfirmed", "transport_completed", &request) {
		t.Fatal("explicit disposition did not resolve initial progress")
	}
	state.State = "automation"
	if terminalControlTransition(request, "actor", state, now) == nil {
		t.Fatal("initial disposition resumed automation")
	}
	request.Action = "resume_automation"
	request.DraftHandled = true
	if terminalInitialProgress("unknown", "transport_completed", &request) {
		t.Fatal("automation handback also resolved initial delivery")
	}
}

type terminalControlFixture struct {
	fixture
	message    v2.Message
	binding    v2.Binding
	segment    string
	now        time.Time
	browser    string
	operations *terminalControlOperations
}

func terminalControlSetup(t *testing.T) *terminalControlFixture {
	t.Helper()
	f, m := terminalFixture(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	f.s.now = func() time.Time { return now }
	in := m.Payload.(v2.Registration)
	x := &terminalControlFixture{fixture: f, message: m, binding: in.Binding, segment: uuid.NewString(), now: now, browser: uuid.NewString()}
	f.s.now = func() time.Time { return x.now }
	x.operations = newTerminalControlOperations(t, x)
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalRegistrationPhase(context.Background(), map[string]int{"InsertTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	run := v2.Run{ExecutionGeneration: "1", Owner: in.Owner, Binding: in.Binding, StartedAt: terminalTime(now), SegmentIDs: []string{x.segment}}
	m.Type = "generation_ledger"
	m.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalPhase(context.Background(), true, map[string]int{"SaveTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	m.Type = "recording_responsibility"
	m.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalPhase(context.Background(), true, map[string]int{"SaveTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	x.worker(t, "1", x.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	return x
}
func (f *terminalControlFixture) msg(kind string, payload v2.Payload) v2.Message {
	m := f.message
	m.Type = kind
	m.Payload = payload
	switch p := payload.(type) {
	case v2.ControlRequest:
		f.operations.expect(p.OperationID)
	case v2.Operation:
		f.operations.expect(p.OperationID)
	}
	return m
}
func (f *terminalControlFixture) worker(t *testing.T, epoch string, m v2.Message) v2.Message {
	t.Helper()
	return f.workerWith(t, epoch, m, nil)
}
func (f *terminalControlFixture) workerWith(t *testing.T, epoch string, m v2.Message, overrides map[string]int) v2.Message {
	t.Helper()
	f.operations.resetWrites()
	f.terminal.ProposedRaw = nil
	work := f.workerPhaseCounts(t, m)
	phase := f.TerminalPhase(context.Background(), m.Type == "control_ack" || m.Type == "operation_result", mergeFixtureCounts(work, overrides))
	out, err := terminalControlCall(f.fixture, phase, func(ctx context.Context) (v2.Message, error) {
		return f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, m.SessionID, epoch, m)
	})
	if err != nil {
		t.Fatal(err)
	}
	f.operations.checkRequired()
	terminalNext(t, f.fixture)
	switch payload := m.Payload.(type) {
	case v2.ControlAck:
		if len(f.operations.results) > 1 {
			t.Fatal("acknowledgement wrote extra operation results")
		}
		if len(f.operations.results) == 1 {
			f.operations.resultInput(payload.Result.OperationID)
		}
		f.operations.pending = false
		f.operations.viewerPending = false
	case v2.OperationResult:
		if len(f.operations.results) > 1 {
			t.Fatal("worker result wrote extra operation results")
		}
		if len(f.operations.results) == 1 {
			f.operations.resultInput(payload.OperationID)
		}
		f.operations.pending = false
		f.operations.viewerPending = false
	}
	return out
}
func (f *terminalControlFixture) submit(t *testing.T, m v2.Message) v2.Message {
	t.Helper()
	return f.submitBy(t, f.p, m)
}
func (f *terminalControlFixture) submitBy(t *testing.T, principal model.Principal, m v2.Message) v2.Message {
	t.Helper()
	f.operations.resetWrites()
	f.terminal.ProposedRaw = nil
	_, operationID := terminalSummary(m)
	old := f.operations.fact(operationID).value
	work := map[string]int{"TerminalOperation": 1}
	if old == nil {
		work = mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1, "TerminalInputPending": 1, "InsertTerminalOperation": 1, "SaveTerminal": 1})
	}
	phase := f.TerminalPhase(context.Background(), false, work)
	out, err := terminalControlCall(f.fixture, phase, func(ctx context.Context) (v2.Message, error) {
		return f.s.SubmitTerminal(ctx, principal, f.project, f.task, m.SessionID, f.browser, m)
	})
	if err != nil {
		t.Fatal(err)
	}
	f.operations.checkRequired()
	if old == nil {
		if out.Payload.(v2.OperationResult).State != "queued" {
			t.Fatal("new submission did not return queued")
		}
		if len(f.operations.inserted) != 1 || f.operations.inserted[0].Actor != principal {
			t.Fatal("submission did not retain its original actor")
		}
		f.operations.insertedInput(operationID)
		terminalNext(t, f.fixture)
		f.operations.queued = append(f.operations.queued, operationID)
		f.operations.pending = true
		f.operations.viewerPending = true
	} else if len(f.operations.inserted) != 0 {
		t.Fatal("idempotent submission attempted a new ledger write")
	}
	return out
}
func (f *terminalControlFixture) poll(t *testing.T, epoch string) []v2.Message {
	t.Helper()
	return f.pollWith(t, epoch, len(f.operations.queued))
}
func (f *terminalControlFixture) pollWith(t *testing.T, epoch string, wantOffers int) []v2.Message {
	t.Helper()
	return f.pollCounts(t, epoch, wantOffers, nil)
}
func (f *terminalControlFixture) pollCounts(t *testing.T, epoch string, wantOffers int, overrides map[string]int) []v2.Message {
	t.Helper()
	queued := append([]string(nil), f.operations.queued...)
	f.operations.resetWrites()
	f.terminal.ProposedRaw = nil
	work := f.refreshPhaseCounts(t)
	credentialCalls, projectCalls := 1, 1
	if count, ok := work["LockCredential"]; ok {
		credentialCalls = count
	}
	if count, ok := work["ProjectAccess"]; ok {
		projectCalls = count
	}
	work = mergeFixtureCounts(work, map[string]int{"QueuedTerminalOperation": 1, "TerminalOperation": len(queued), "SetTerminalOperationResult": len(queued), "SetSessionOperationEpoch": wantOffers, "SaveTerminal": 1, "LockCredential": credentialCalls + len(queued), "ProjectAccess": projectCalls + len(queued)})
	phase := f.TerminalPhase(context.Background(), false, mergeFixtureCounts(work, overrides))
	out, err := terminalControlCall(f.fixture, phase, func(ctx context.Context) ([]v2.Message, error) {
		return f.s.PollTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, epoch)
	})
	if err != nil {
		t.Fatal(err)
	}
	f.operations.checkRequired()
	if len(out) != wantOffers || len(f.operations.results) != len(queued) || len(f.operations.epochs) != wantOffers {
		t.Fatal("poll wrote an unexpected number of operation outcomes or dispatch epochs")
	}
	for _, operationID := range queued {
		result := f.operations.resultWrite(operationID)
		if result.State == "dispatching" {
			f.operations.dispatchInput(operationID)
		} else if result.State == "rejected" {
			f.operations.resultInput(operationID)
		} else {
			t.Fatal("unexpected poll result", result)
		}
	}
	terminalNext(t, f.fixture)
	f.operations.queued = nil
	f.operations.pending = wantOffers > 0
	f.operations.viewerPending = wantOffers > 0
	return out
}
func (f *terminalControlFixture) control(t *testing.T) *v2.ControlState {
	t.Helper()
	f.operations.checkRequired()
	var out *v2.ControlState
	phase := f.TerminalPhase(context.Background(), false, nil)
	_, err := terminalControlCall(f.fixture, phase, func(ctx context.Context) (struct{}, error) {
		return struct{}{}, f.s.terminalAccess(ctx, f.p, f.project, f.task, f.message.SessionID, false, func(_ *operationTx, r *terminalRecord, _ task, _ bool) error { out = r.Control; return nil })
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *terminalControlFixture) acquire(t *testing.T) v2.Lease {
	t.Helper()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	offers := f.poll(t, "1")
	if len(offers) != 1 {
		t.Fatal(offers)
	}
	dispatch := offers[0].Payload.(v2.ControlDispatch)
	lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "keys", "renew_control", "release_control"}}
	f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
	return lease
}
func (f *terminalControlFixture) input(lease v2.Lease, seq, text string) v2.Message {
	return f.msg("operation", v2.Operation{OperationID: uuid.NewString(), ConnectionEpoch: "1", SegmentID: f.segment, Binding: f.binding, ControlEpoch: lease.ControlEpoch, LeaseID: lease.LeaseID, LeaseSeq: seq, Kind: "paste", Payload: v2.Paste{Text: text}})
}

func TestTerminalClosedStateSurvivesDisconnectAndReconnect(t *testing.T) {
	for _, state := range []string{"closing", "closed"} {
		t.Run(state, func(t *testing.T) {
			f := terminalControlSetup(t)
			ctx := context.Background()
			f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: state, InitialAssignment: "transport_completed", AvailableActions: []string{}}))
			if err := terminalErrorStep(t, f.fixture, func() error {
				return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2}), func(phaseCtx context.Context) error {
					return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
				})
			}); err != nil {
				t.Fatal(err)
			}
			if got := f.control(t); got.State != state {
				t.Fatalf("disconnect reopened terminal: %+v", got)
			}
			registration := f.message.Payload.(v2.Registration)
			registration.Mode = "reconnect"
			epoch := "1"
			registration.ConnectionEpoch = &epoch
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(ctx, map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
					return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, f.msg("registration", registration))
				})
			}); err != nil {
				t.Fatal(err)
			}
			if got := f.control(t); got.State != state {
				t.Fatalf("reconnect reopened terminal: %+v", got)
			}
			for _, target := range []string{"suspended", "automation"} {
				m := f.msg("control_state", v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "4", State: target, InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}})
				if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
						return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "2", m)
					})
				}); err == nil {
					t.Fatalf("%s reopened as %s", state, target)
				}
			}
		})
	}
}

func TestTerminalControlEpochExhaustionClosesWithoutOverflow(t *testing.T) {
	f := terminalControlSetup(t)
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "9223372036854775807", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{}}))
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	got := f.control(t)
	if got.ControlEpoch != "9223372036854775807" || got.State != "closed" {
		t.Fatalf("exhausted control fence wrapped: %+v", got)
	}
}

func TestTerminalFinalizationClearsTransientPreviewAndCommandBodies(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	f.s.terminalFrames = map[string]*terminalFrameWrite{m.SessionID: {raw: []byte("private screen")}}
	f.s.terminalPending = map[string]map[string]*terminalBodyWrite{m.SessionID: {uuid.NewString(): {raw: []byte("private input")}}}
	finalizeFixture(t, f, m, doc)
	if len(f.s.terminalFrames) != 0 || len(f.s.terminalPending) != 0 {
		t.Fatal("finalized terminal retained transient content")
	}
}

func TestTerminalFinalizationFencesDelayedCommittedSnapshot(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	// The durable snapshot transaction has committed, but its callback has not
	// run yet. Finalization must invalidate that callback before releasing data.
	publish, _, err := stageTerminalTestSnapshot(f.s, m.SessionID, []byte("delayed private screen"))
	if err != nil {
		t.Fatal(err)
	}
	finalizeFixture(t, f, m, doc)
	publish()
	if len(f.s.terminalFrames) != 0 || len(f.s.terminalFrameWrites) != 0 {
		t.Fatal("delayed callback resurrected finalized preview")
	}
	// Read fencing also rejects a stale cache supplied independently of callbacks.
	x := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: x.segment, SegmentOrdinal: "1", Binding: x.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(x.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "private"}}}}}
	x.worker(t, "1", x.msg("snapshot", snapshot))
	err = terminalErrorStep(t, x.fixture, func() error {
		return terminalControlInputError(x, x.fixture.TerminalPhase(context.Background(), false, nil), func(phaseCtx context.Context) error {
			return x.s.terminalAccess(phaseCtx, x.p, x.project, x.task, x.message.SessionID, false, func(_ *operationTx, r *terminalRecord, _ task, _ bool) error {
				finalID := uuid.NewString()
				r.FinalizationID = &finalID
				if x.s.terminalSnapshot(r) != nil {
					t.Fatal("finalized record exposed cached frame")
				}
				return nil
			})
		})
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTerminalSnapshotReservationsAreBoundedAndLatestCommitWins(t *testing.T) {
	s := &Execution{Engine: &Engine{}}
	first, cancelFirst, err := stageTerminalTestSnapshot(s, "session", []byte("first"))
	if err != nil {
		t.Fatal(err)
	}
	latest, _, err := stageTerminalTestSnapshot(s, "session", []byte("latest"))
	if err != nil {
		t.Fatal(err)
	}
	cancelFirst()
	latest()
	first()
	if string(s.terminalFrames["session"].raw) != "latest" {
		t.Fatal("stale callback replaced latest frame")
	}
	_, cancel, err := stageTerminalTestSnapshot(s, "session", []byte("rollback"))
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if string(s.terminalFrames["session"].raw) != "latest" {
		t.Fatal("rollback changed committed preview")
	}
	for i := 1; i < maxLiveSessions; i++ {
		if _, _, err := stageTerminalTestSnapshot(s, decimal(int64(i)), []byte("pending")); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := stageTerminalTestSnapshot(s, "overflow", []byte("pending")); err == nil {
		t.Fatal("pending previews escaped capacity limit")
	}
	s.forgetTerminalSnapshot("session")
	if _, _, err := stageTerminalTestSnapshot(s, "replacement", []byte("pending")); err != nil {
		t.Fatal("released preview retained capacity", err)
	}
}

func TestTerminalFrameOrderingSurvivesDelayedPublication(t *testing.T) {
	f := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "100", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "newest private screen"}}}}}
	m := f.msg("snapshot", snapshot)
	f.worker(t, "1", m)
	// Reproduce the post-commit/pre-publication state: durable acceptance exists,
	// but only its reserved callback can publish the frame.
	f.s.forgetTerminalSnapshot(m.SessionID)
	publish, _, err := stageTerminalTestSnapshot(f.s, m.SessionID, encode(m))
	if err != nil {
		t.Fatal(err)
	}
	older := snapshot
	older.Frame.FrameSeq = "1"
	if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, m.SessionID, "1", f.msg("snapshot", older))
		})
	}); err == nil {
		t.Fatal("older frame replaced a committed unpublished frame")
	}
	publish()
	f.s.forgetTerminalSnapshot(m.SessionID)
	changed := snapshot
	changed.Frame.Width = 2
	if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, m.SessionID, "1", f.msg("snapshot", changed))
		})
	}); err == nil {
		t.Fatal("conflicting duplicate accepted after cache loss")
	}
	f.worker(t, "1", m)
	persisted := string(f.terminal.Raw)
	if strings.Contains(persisted, "newest private screen") {
		t.Fatal("frame content persisted with ordering metadata")
	}
	registration := f.message.Payload.(v2.Registration)
	registration.Mode = "reconnect"
	epoch := "1"
	registration.ConnectionEpoch = &epoch
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(context.Background(), map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, f.msg("registration", registration))
		})
	}); err != nil {
		t.Fatal(err)
	}
	snapshot.ConnectionEpoch = "2"
	f.worker(t, "2", f.msg("snapshot", snapshot))
	older.ConnectionEpoch = "2"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, m.SessionID, "2", f.msg("snapshot", older))
		})
	}); err == nil {
		t.Fatal("reconnect reset the current segment's frame order")
	}
}

func TestTerminalExpiredHTTPPreviewsReleaseCapacityWithoutArchive(t *testing.T) {
	now := time.Now()
	s := &Execution{Engine: &Engine{now: func() time.Time { return now }}}
	for i := range maxLiveSessions {
		publish, _, err := stageTerminalTestSnapshot(s, decimal(int64(i)), []byte("expired HTTP preview"))
		if err != nil {
			t.Fatal(err)
		}
		publish()
	}
	now = now.Add(HeartbeatTimeout + time.Second)
	publish, _, err := stageTerminalTestSnapshot(s, "next", []byte("new HTTP preview"))
	if err != nil {
		t.Fatal("expired HTTP-only producers permanently consumed capacity", err)
	}
	publish()
	if len(s.terminalFrames) != 1 {
		t.Fatal("expired previews retained", len(s.terminalFrames))
	}
}

func TestTerminalRevokedWorkerDisconnectStillReleasesPreview(t *testing.T) {
	f := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "private screen"}}}}}
	f.worker(t, "1", f.msg("snapshot", snapshot))
	revokeFixtureCredential(t, f.fixture, f.p)
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, map[string]int{"ProjectAccess": 0, "LockTerminal": 0}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
		})
	}); err == nil {
		t.Fatal("revoked principal unexpectedly retained database permission")
	}
	if len(f.s.terminalFrames) != 0 {
		t.Fatal("revoked Worker disconnect retained preview")
	}
}

func TestTerminalPreviewReclamationPreservesActiveAndReservedConnections(t *testing.T) {
	now := time.Now()
	s := &Execution{Engine: &Engine{now: func() time.Time { return now }}}
	r := &terminalRecord{Envelope: v2.Envelope{SessionID: "active", ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}
	active, _, err := s.stageTerminalSnapshot(r, []byte("active"))
	if err != nil {
		t.Fatal(err)
	}
	active()
	for i := 1; i < maxLiveSessions; i++ {
		publish, _, err := stageTerminalTestSnapshot(s, decimal(int64(i)), []byte("expired"))
		if err != nil {
			t.Fatal(err)
		}
		publish()
	}
	now = now.Add(20 * time.Second)
	s.touchTerminalSnapshot(r.Envelope, "1", now)
	now = now.Add(11 * time.Second)
	reserved := *r
	reserved.Envelope.SessionID = "reserved"
	publishReserved, _, err := s.stageTerminalSnapshot(&reserved, []byte("reserved"))
	if err != nil {
		t.Fatal(err)
	}
	if s.terminalFrames["active"] == nil || len(s.terminalFrames) != 1 {
		t.Fatal("heartbeat did not preserve only the live preview")
	}
	// Filling capacity with reservations must not evict an in-flight write.
	for i := 2; i < maxLiveSessions; i++ {
		if _, _, err := stageTerminalTestSnapshot(s, decimal(int64(i)), []byte("pending")); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := stageTerminalTestSnapshot(s, "overflow", []byte("pending")); err == nil {
		t.Fatal("capacity eviction discarded active reservations")
	}
	publishReserved()
	if s.terminalFrames["reserved"] == nil {
		t.Fatal("pending write lost its reservation")
	}
}

func TestTerminalOldDisconnectCannotClearNewPreviewOrPendingWrite(t *testing.T) {
	s := &Execution{Engine: &Engine{now: time.Now}}
	r := &terminalRecord{Envelope: v2.Envelope{SessionID: "session", ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}
	publish, _, err := s.stageTerminalSnapshot(r, []byte("original"))
	if err != nil {
		t.Fatal(err)
	}
	publish()
	r.ConnectionEpoch = "2"
	newPublish, _, err := s.stageTerminalSnapshot(r, []byte("new"))
	if err != nil {
		t.Fatal(err)
	}
	s.forgetTerminalConnection("owner", r.Envelope, "1")
	if s.terminalFrames["session"] != nil || s.terminalFrameWrites["session"] == nil {
		t.Fatal("old cleanup affected the new reservation")
	}
	newPublish()
	s.forgetTerminalConnection("owner", r.Envelope, "1")
	s.forgetTerminalConnection("other owner", r.Envelope, "2")
	s.touchTerminalSnapshot(r.Envelope, "1", time.Now().Add(time.Hour))
	if got := s.terminalFrames["session"]; got == nil || string(got.raw) != "new" || time.Until(got.lastSeen) > time.Minute {
		t.Fatal("stale disconnect/heartbeat affected new preview")
	}
	s.forgetTerminalConnection("owner", r.Envelope, "2")
	if len(s.terminalFrames) != 0 {
		t.Fatal("current connection cleanup did not release preview")
	}
}

func TestTerminalDelayedSuspensionCleanupPreservesNewCommandBody(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "old input")
	f.submit(t, input)
	f.operations.whenInvalidated(input.Payload.(v2.Operation).OperationID, "rejected", "stale_fence")
	ctx := context.Background()
	op, err := f.s.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	completion, err := terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (store.Completion, error) {
		return f.writer.WriteSession(phaseCtx, func(scope store.SessionScope) error {
			tx := &operationTx{dao: scope.SessionDAO(), bot: scope.BotDAO(), op: op}
			r, err := loadTerminal(phaseCtx, tx, f.message.SessionID)
			if err != nil {
				return err
			}
			return f.s.suspendTerminal(phaseCtx, tx, r)
		})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("suspension: %v %v", completion, err)
	}
	f.operations.checkRequired()
	terminalNext(t, f.fixture)
	// The new connection writes after the row lock is released and before the committed cleanup runs.
	newID := uuid.NewString()
	if err = storeTerminalTestBody(f.s, f.message.SessionID, newID, []byte("new input")); err != nil {
		t.Fatal(err)
	}
	op.Finish(completion.Outcome)
	if string(f.s.terminalBody(f.message.SessionID, newID)) != "new input" {
		t.Fatal("delayed suspension discarded a newer command body")
	}
}

func TestTerminalExpiredBodySlotsPermitNewSubmission(t *testing.T) {
	f := terminalControlSetup(t)
	for i := range maxLiveSessions {
		if err := storeTerminalTestBody(f.s, decimal(int64(i)), uuid.NewString(), []byte("abandoned input")); err != nil {
			t.Fatal(err)
		}
	}
	f.now = f.now.Add(time.Duration(v2.InputTimeoutMillis) * time.Millisecond)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	if got := f.submit(t, f.msg("control_request", req)).Payload.(v2.OperationResult); got.State != "queued" {
		t.Fatal(got)
	}
	if len(f.s.terminalPending) != 1 {
		t.Fatal("expired body entries retained quota", len(f.s.terminalPending))
	}
}

func TestTerminalRevokedWorkerDisconnectReleasesQueuedBody(t *testing.T) {
	f := terminalControlSetup(t)
	actor := listCredential(t, f.fixture, f.p.UserID, model.PATCredential)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submitBy(t, actor, f.msg("control_request", req))
	revokeFixtureCredential(t, f.fixture, f.p)
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, map[string]int{"ProjectAccess": 0, "LockTerminal": 0}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
		})
	}); err == nil {
		t.Fatal("revoked principal retained database permission")
	}
	if len(f.s.terminalPending) != 0 {
		t.Fatal("revoked original connection retained queued body")
	}
}

func TestTerminalBodyDeadlineMatchesLedgerAndRetainsUnexpiredInput(t *testing.T) {
	f := terminalControlSetup(t)
	f.now = f.now.Add(123 * time.Nanosecond)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	deadline := f.operations.operation(req.OperationID).Deadline
	if !f.s.terminalPending[f.message.SessionID][req.OperationID].deadline.Equal(deadline) {
		t.Fatal("cache deadline differs from durable deadline")
	}
	f.now = deadline.Add(-time.Nanosecond)
	if len(f.s.terminalBody(f.message.SessionID, req.OperationID)) == 0 {
		t.Fatal("unexpired queued body was discarded")
	}
	f.now = deadline
	if len(f.s.terminalBody(f.message.SessionID, req.OperationID)) != 0 || len(f.s.terminalPending) != 0 {
		t.Fatal("expired body was readable or retained its quota")
	}
	f.operations.whenExpired(req.OperationID, "rejected", "input_busy")
	if offered := f.pollWith(t, "1", 0); len(offered) != 0 {
		t.Fatal("expired body was dispatched", offered)
	}
	result, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, req.OperationID)
		})
	})
	if err != nil || result.Payload.(v2.OperationResult).State != "rejected" {
		t.Fatal("expiry did not retain durable rejection", result, err)
	}
}

func TestTerminalOldDisconnectPreservesNewConnectionBody(t *testing.T) {
	s := &Execution{Engine: &Engine{now: time.Now}}
	fence := v2.Envelope{SessionID: "session", ClaimID: "claim", ExecutionGeneration: "1"}
	r := &terminalRecord{Envelope: fence, ConnectionEpoch: "2", Owner: v2.Owner{OwnerUserID: "owner"}}
	if _, err := s.storeTerminalBody(r, "operation", []byte("new input"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	s.forgetTerminalConnection("owner", fence, "1")
	s.forgetTerminalConnection("another owner", fence, "2")
	if string(s.terminalBody("session", "operation")) != "new input" {
		t.Fatal("stale connection removed a current queued body")
	}
	s.forgetTerminalConnection("owner", fence, "2")
	if len(s.terminalPending) != 0 {
		t.Fatal("current connection retained queued body")
	}
}

func TestTerminalDeadlineObservationReclaimsExpiredBody(t *testing.T) {
	f := terminalControlSetup(t)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	f.now = f.now.Add(time.Duration(v2.InputTimeoutMillis) * time.Millisecond)
	f.operations.whenExpired(req.OperationID, "rejected", "input_busy")
	got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, req.OperationID)
		})
	})
	if err != nil || got.Payload.(v2.OperationResult).State != "rejected" {
		t.Fatal(got, err)
	}
	if len(f.s.terminalPending) != 0 {
		t.Fatal("observed operation deadline retained its body")
	}
}

func TestTerminalRolledBackBodyCleanupCannotDeleteSuccessfulSameIDRetry(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	m := f.msg("control_request", req)
	var cancelFailedWrite func()
	rollback := errors.New("test rollback")
	completion, err := terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, map[string]int{"LockTerminal": 1}), func(phaseCtx context.Context) (store.Completion, error) {
		return f.writer.WriteSession(phaseCtx, func(scope store.SessionScope) error {
			tx := &operationTx{dao: scope.SessionDAO(), bot: scope.BotDAO(), op: &Operation{}}
			r, err := loadTerminal(phaseCtx, tx, m.SessionID)
			if err != nil {
				return err
			}
			cancelFailedWrite, err = f.s.storeTerminalBody(r, req.OperationID, encode(m), f.now.Add(time.Duration(v2.InputTimeoutMillis)*time.Millisecond))
			if err != nil {
				return err
			}
			return rollback
		})
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %v %v", completion, err)
	}
	if got := f.submit(t, m).Payload.(v2.OperationResult); got.State != "queued" {
		t.Fatal(got)
	}
	cancelFailedWrite()
	if offered := f.poll(t, "1"); len(offered) != 1 || offered[0].Payload.(v2.ControlDispatch).Request.OperationID != req.OperationID {
		t.Fatal("rollback cleanup deleted the successfully retried body", offered)
	}
	if offered := f.pollWith(t, "1", 0); len(offered) != 0 {
		t.Fatal("successful retry was replayed", offered)
	}
}

func TestTerminalSuspensionOfRolledBackBodyCannotDeleteSameIDRetry(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	rollback := errors.New("test rollback")
	completion, err := terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, map[string]int{"LockTerminal": 1}), func(phaseCtx context.Context) (store.Completion, error) {
		return f.writer.WriteSession(phaseCtx, func(scope store.SessionScope) error {
			tx := &operationTx{dao: scope.SessionDAO(), bot: scope.BotDAO(), op: &Operation{}}
			r, err := loadTerminal(phaseCtx, tx, f.message.SessionID)
			if err != nil {
				return err
			}
			if _, err = f.s.storeTerminalBody(r, req.OperationID, encode(f.msg("control_request", req)), f.now.Add(time.Second)); err != nil {
				return err
			}
			return rollback
		})
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %v %v", completion, err)
	}
	// Suspension captures the failed write; a later same-ID retry must survive its delayed cleanup.
	op, err := f.s.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	completion, err = terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (store.Completion, error) {
		return f.writer.WriteSession(phaseCtx, func(scope store.SessionScope) error {
			tx := &operationTx{dao: scope.SessionDAO(), bot: scope.BotDAO(), op: op}
			r, err := loadTerminal(phaseCtx, tx, f.message.SessionID)
			if err != nil {
				return err
			}
			return f.s.suspendTerminal(phaseCtx, tx, r)
		})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("suspension: %v %v", completion, err)
	}
	f.operations.checkRequired()
	terminalNext(t, f.fixture)
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	req.ControlEpoch = "2"
	f.submit(t, f.msg("control_request", req))
	op.Finish(completion.Outcome)
	if offered := f.poll(t, "1"); len(offered) != 1 || offered[0].Payload.(v2.ControlDispatch).Request.OperationID != req.OperationID {
		t.Fatal("suspension cleanup deleted a same-ID replacement", offered)
	}
}

func TestTerminalFailedInsertCancelsItsBodyAndPermitsRetry(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	insert := f.dao.InsertTerminalOperationFn
	injected := errors.New("operation insert refused")
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.dao.Expect("InsertTerminalOperation", 2)
	f.dao.InsertTerminalOperationFn = func(_ context.Context, in store.TerminalOperation) error {
		if in.SessionID != f.message.SessionID || in.OperationID != req.OperationID || in.Actor != f.p {
			t.Fatal("failed insertion used unexpected Session, operation or actor")
		}
		return injected
	}
	m := f.msg("control_request", req)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1, "TerminalInputPending": 1, "InsertTerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, m.SessionID, f.browser, m)
		})
	}); !errors.Is(err, injected) {
		t.Fatal("insert error chain was not preserved", err)
	}
	if len(f.s.terminalPending) != 0 {
		t.Fatal("failed insert retained its body reservation")
	}
	f.dao.InsertTerminalOperationFn = insert
	f.submit(t, m)
	if offered := f.poll(t, "1"); len(offered) != 1 {
		t.Fatal("same-ID retry after failure was not dispatched", offered)
	}
}

func TestTerminalForeignHealthyRelayCannotRevokeControlOrPendingOperation(t *testing.T) {
	for _, endpoint := range []string{"current", "state", "operation", "submit"} {
		for _, dispatched := range []bool{false, true} {
			t.Run(endpoint+map[bool]string{false: "/queued", true: "/dispatching"}[dispatched], func(t *testing.T) {
				f := terminalControlSetup(t)
				lease := f.acquire(t)
				input := f.input(lease, "1", "original instance input")
				f.submit(t, input)
				if dispatched {
					f.poll(t, "1")
				}
				other := New(f.writer)
				other.now = f.s.now
				ctx := context.Background()
				before := string(f.terminal.Raw)
				var err error
				switch endpoint {
				case "current":
					_, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
						return terminalControlInputCall(f, f.fixture.TaskPhase(ctx, map[string]int{"CurrentTerminalSession": 1, "LockTerminal": 1}), func(phaseCtx context.Context) (map[string]any, error) {
							return other.CurrentTerminal(phaseCtx, f.p, f.project, f.task)
						})
					})
				case "state":
					_, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
						return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, nil), func(phaseCtx context.Context) (map[string]any, error) {
							return other.TerminalState(phaseCtx, f.p, f.project, f.task, input.SessionID)
						})
					})
				case "operation":
					_, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
						return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, nil), func(phaseCtx context.Context) (v2.Message, error) {
							return other.TerminalOperation(phaseCtx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
						})
					})
				case "submit":
					_, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
						return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
							return other.SubmitTerminal(phaseCtx, f.p, f.project, f.task, input.SessionID, f.browser, f.input(lease, "2", "wrong relay"))
						})
					})
				}
				after := string(f.terminal.Raw)
				if before != after {
					t.Fatal("foreign relay mutated healthy original control state")
				}
				var refusal *model.Fault
				if !errors.As(err, &refusal) || refusal.Code != "relay_instance_unavailable" {
					t.Fatalf("missing explicit relay routing refusal: %v", err)
				}
				got, readErr := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
						return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
					})
				})
				want := map[bool]string{false: "queued", true: "dispatching"}[dispatched]
				if readErr != nil || got.Payload.(v2.OperationResult).State != want {
					t.Fatal("foreign request changed original operation", got, readErr)
				}
				if !dispatched && len(f.poll(t, "1")) != 1 {
					t.Fatal("original Worker could not receive queued body")
				}
			})
		}
	}
}

func TestTerminalForeignRelaySuspendsOnlyAfterHeartbeatLossOrClaimEnd(t *testing.T) {
	for _, cause := range []string{"heartbeat_timeout", "claim_ended"} {
		t.Run(cause, func(t *testing.T) {
			f := terminalControlSetup(t)
			lease := f.acquire(t)
			input := f.input(lease, "1", "pending when owner ends")
			f.submit(t, input)
			f.poll(t, "1")
			other := New(f.writer)
			other.now, other.Origin = f.s.now, f.s.Origin
			registration := f.message.Payload.(v2.Registration)
			registration.Mode = "reconnect"
			epoch := "1"
			registration.ConnectionEpoch = &epoch
			_, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(context.Background(), map[string]int{"LockTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
					return other.RegisterTerminal(phaseCtx, f.p, f.project, f.task, f.msg("registration", registration))
				})
			})
			var refusal *model.Fault
			if !errors.As(err, &refusal) || refusal.Code != "input_busy" {
				t.Fatalf("healthy foreign registration bypassed existing owner: %v", err)
			}
			if cause == "heartbeat_timeout" {
				f.now = f.now.Add(HeartbeatTimeout + time.Second)
			} else {
				archiveTerminal(t, f.fixture)
			}
			f.operations.whenInvalidated(input.Payload.(v2.Operation).OperationID, "unknown", "input_unknown")
			if _, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1, "TerminalArchive": 1}), func(phaseCtx context.Context) (map[string]any, error) {
					return other.TerminalState(phaseCtx, f.p, f.project, f.task, input.SessionID)
				})
			}); err != nil {
				t.Fatal(err)
			}
			if control := f.control(t); control.State != "suspended" || control.Lease != nil || control.ControlEpoch != "3" {
				t.Fatal("lost owner retained manual control", control)
			}
			got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
					return other.TerminalOperation(phaseCtx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
				})
			})
			if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
				t.Fatal("lost owner dispatch did not remain unknown", got, err)
			}
		})
	}
}

func TestTerminalOldViewerCannotRevokeReconnectedWorkerControl(t *testing.T) {
	for _, differentInstance := range []bool{false, true} {
		for _, pendingAcquire := range []bool{false, true} {
			t.Run(map[bool]string{false: "same instance", true: "other instance"}[differentInstance]+map[bool]string{false: "/lease and input", true: "/pending acquire"}[pendingAcquire], func(t *testing.T) {
				f := terminalControlSetup(t)
				f.acquire(t)
				original := f.s
				if differentInstance {
					f.s = New(f.writer)
					f.s.now, f.s.Origin = original.now, original.Origin
				}
				f.now = f.now.Add(HeartbeatTimeout + time.Second)
				reg := f.message.Payload.(v2.Registration)
				reg.Mode = "reconnect"
				previous := "1"
				reg.ConnectionEpoch = &previous
				if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(context.Background(), map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
						return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, f.msg("registration", reg))
					})
				}); err != nil {
					t.Fatal(err)
				}
				f.worker(t, "2", f.msg("control_state", v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "2", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
				req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "2", ControlEpoch: "2", Action: "acquire_control", BrowserClientID: f.browser}
				f.submit(t, f.msg("control_request", req))
				opID := req.OperationID
				if !pendingAcquire {
					dispatch := f.poll(t, "2")[0].Payload.(v2.ControlDispatch)
					lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "3", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
					state := v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "3", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "release_control"}}
					f.worker(t, "2", f.msg("control_ack", v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
					input := f.input(lease, "1", "new connection input").Payload.(v2.Operation)
					input.ConnectionEpoch = "2"
					f.submit(t, f.msg("operation", input))
					opID = input.OperationID
				}
				ctx := context.Background()
				before := string(f.terminal.Raw)
				if err := terminalErrorStep(t, f.fixture, func() error {
					return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, nil), func(phaseCtx context.Context) error {
						return original.DisconnectTerminalViewer(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1")
					})
				}); err != nil {
					t.Fatal(err)
				}
				after := string(f.terminal.Raw)
				if before != after {
					t.Fatal("old viewer revoked reconnected Worker state")
				}
				got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
						return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, opID)
					})
				})
				if err != nil || got.Payload.(v2.OperationResult).State != "queued" {
					t.Fatal("old viewer rejected the new operation", got, err)
				}
				f.operations.whenInvalidated(opID, "rejected", "stale_fence")
				if err := terminalErrorStep(t, f.fixture, func() error {
					return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalViewerOperationPending": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) error {
						return f.s.DisconnectTerminalViewer(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "2")
					})
				}); err != nil {
					t.Fatal(err)
				}
				got, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
						return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, opID)
					})
				})
				if err != nil || got.Payload.(v2.OperationResult).State != "rejected" {
					t.Fatal("current viewer did not release its operation", got, err)
				}
			})
		}
	}
}

func TestTerminalViewerStillReleasesLeaseAfterSameConnectionGenerationAdvance(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	// Observing a native identity permits a stopped run to advance while keeping
	// the same Worker connection and browser subscription.
	nativeID := "native-session"
	binding := f.binding
	binding.NativeSessionID = &nativeID
	f.worker(t, "1", f.msg("snapshot", v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "observed"}}}}}))
	var run v2.Run
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, nil), func(phaseCtx context.Context) error {
			return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, f.message.SessionID, false, func(_ *operationTx, r *terminalRecord, _ task, _ bool) error { run = r.Runs[0]; return nil })
		})
	}); err != nil {
		t.Fatal(err)
	}
	stopped := terminalTime(f.now)
	run.StoppedAt = &stopped
	run.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	f.message.ExecutionGeneration = "2"
	newRun := v2.Run{ExecutionGeneration: "2", Owner: run.Owner, Binding: binding, StartedAt: stopped, SegmentIDs: []string{uuid.NewString()}}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run, newRun}}))
		})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("recording_responsibility", v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}))
		})
	}); err != nil {
		t.Fatal(err)
	}
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	f.acquire(t)
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalViewerOperationPending": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminalViewer(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	if control := f.control(t); control.State != "suspended" || control.Lease != nil {
		t.Fatal("same-connection generation advance lost viewer cleanup responsibility", control)
	}
}

func TestTerminalInputCannotDispatchToPriorCollectionSegment(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "prior segment")
	f.submit(t, input)
	err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"SaveTerminal": 1}), func(phaseCtx context.Context) error {
			return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, f.message.SessionID, false, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
				r.Runs[0].SegmentIDs = append(r.Runs[0].SegmentIDs, uuid.NewString())
				return saveTerminal(phaseCtx, tx, r)
			})
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if offered := f.pollWith(t, "1", 0); len(offered) != 0 {
		t.Fatal("input offered to a prior segment", offered)
	}
	out, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, input.Payload.(v2.Operation).OperationID)
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := out.Payload.(v2.OperationResult); got.State != "rejected" {
		t.Fatal(got)
	}
}

func TestTerminalControlDurableAcknowledgementAndInputLedger(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	request := f.msg("control_request", req)
	if got := f.submit(t, request).Payload.(v2.OperationResult); got.State != "queued" {
		t.Fatal(got)
	}
	if f.control(t).Lease != nil {
		t.Fatal("queue granted lease before Worker acknowledgement")
	}
	offers := f.poll(t, "1")
	if len(offers) != 1 {
		t.Fatal(offers)
	}
	if len(f.pollWith(t, "1", 0)) != 0 {
		t.Fatal("control request replayed")
	}
	dispatch := offers[0].Payload.(v2.ControlDispatch)
	if dispatch.ActorUserID != f.p.UserID || dispatch.Request != req {
		t.Fatal(dispatch)
	}
	lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "keys", "renew_control", "release_control"}}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, request.SessionID, "1", f.msg("control_state", state))
		})
	}); err == nil {
		t.Fatal("unsolicited manual state granted lease")
	}
	ack := v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}
	wrong := ack
	wrong.RequestDigest = strings.Repeat("0", 64)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, request.SessionID, "1", f.msg("control_ack", wrong))
		})
	}); err == nil {
		t.Fatal("uncorrelated durable acknowledgement accepted")
	}
	f.worker(t, "1", f.msg("control_ack", ack))
	if got := f.control(t).Lease; got == nil || *got != lease {
		t.Fatal(got)
	}
	input := f.input(lease, "1", "private-terminal-paste")
	f.submit(t, input)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1, "TerminalInputPending": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, input.SessionID, f.browser, f.input(lease, "2", "other"))
		})
	}); err == nil {
		t.Fatal("second unresolved batch accepted")
	}
	persisted := string(f.operations.operation(input.Payload.(v2.Operation).OperationID).Command)
	if strings.Contains(persisted, "private-terminal-paste") {
		t.Fatal("native paste persisted in the server control ledger")
	}
	offers = f.poll(t, "1")
	if len(offers) != 1 || offers[0].Payload.(v2.Operation).Payload.(v2.Paste).Text != "private-terminal-paste" {
		t.Fatal(offers)
	}
	if len(f.pollWith(t, "1", 0)) != 0 {
		t.Fatal("native input replayed")
	}
	opID := input.Payload.(v2.Operation).OperationID
	f.worker(t, "1", f.msg("operation_result", terminalResult(opID, "unknown", "input_unknown")))
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "unknown" {
		t.Fatal(got)
	}
	changed := input
	body := input.Payload.(v2.Operation)
	body.Payload = v2.Paste{Text: "different"}
	changed.Payload = body
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, input.SessionID, f.browser, changed)
		})
	}); err == nil {
		t.Fatal("same operation ID accepted different body")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, input.SessionID, "1", f.msg("operation_result", terminalResult(opID, "transport_completed", "")))
		})
	}); err == nil {
		t.Fatal("unknown was converted into success")
	}
}

func TestTerminalTimeoutAndReconnectNeverReplayOrRestoreControl(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "time out")
	f.submit(t, input)
	f.poll(t, "1")
	f.now = f.now.Add(11 * time.Second)
	f.operations.whenExpired(input.Payload.(v2.Operation).OperationID, "unknown", "input_unknown")
	got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
		})
	})
	if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
		t.Fatal(got, err)
	}
	reconnect := f.message
	registration := f.message.Payload.(v2.Registration)
	epoch := "1"
	registration.Mode = "reconnect"
	registration.ConnectionEpoch = &epoch
	reconnect.Payload = registration
	ack, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(context.Background(), map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, reconnect)
		})
	})
	if err != nil || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack, err)
	}
	if f.control(t).Lease != nil || f.control(t).State != "suspended" {
		t.Fatal("reconnect revived control")
	}
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "unknown" {
		t.Fatal(got)
	}
	if len(f.pollWith(t, "2", 0)) != 0 {
		t.Fatal("reconnect replayed input")
	}
	state := v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "3", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, input.SessionID, "2", f.msg("control_state", state))
		})
	}); err == nil {
		t.Fatal("reconnect resumed automation without handoff")
	}
}

func TestTerminalLostQueuedBodyIsRejectedWithoutPersistingOrReplayingInput(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "do not persist")
	f.submit(t, input)
	id := input.Payload.(v2.Operation).OperationID
	f.s.forgetTerminalBody(input.SessionID, id)
	if len(f.pollWith(t, "1", 0)) != 0 {
		t.Fatal("missing body was offered")
	}
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "rejected" {
		t.Fatal(got)
	}
}

func TestTerminalPendingAcquireIsRevokedWhenItsBrowserDisconnects(t *testing.T) {
	f := terminalControlSetup(t)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	f.poll(t, "1")
	f.operations.whenInvalidated(req.OperationID, "unknown", "input_unknown")
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"TerminalViewerOperationPending": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminalViewer(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, req.OperationID)
		})
	})
	if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
		t.Fatal(got, err)
	}
}

func TestTerminalSnapshotIsTransientAndBoundToRegisteredSegment(t *testing.T) {
	f := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "private-screen"}}}}}
	f.worker(t, "1", f.msg("snapshot", snapshot))
	persisted := string(f.terminal.Raw)
	if strings.Contains(persisted, "private-screen") {
		t.Fatal("terminal screen persisted outside archive storage")
	}
	var rec terminalRecord
	if err := json.Unmarshal([]byte(persisted), &rec); err != nil {
		t.Fatal(err)
	}
	if !rec.Recording["1"].ObservedContent {
		t.Fatal("positive recording observation was not preserved")
	}
	if f.s.terminalSnapshot(&rec) == nil {
		t.Fatal("latest live snapshot missing")
	}
	snapshot.SegmentID = uuid.NewString()
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", snapshot))
		})
	}); err == nil {
		t.Fatal("foreign segment preview accepted")
	}
}

func TestTerminalLeaseRenewReleaseAndExplicitAutomationHandoff(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	transition := func(req v2.ControlRequest, state v2.ControlState) {
		t.Helper()
		f.submit(t, f.msg("control_request", req))
		offers := f.poll(t, "1")
		if len(offers) != 1 {
			t.Fatal(offers)
		}
		d := offers[0].Payload.(v2.ControlDispatch)
		f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
	}
	f.now = f.now.Add(10 * time.Second)
	lease.ExpiresAt = terminalTime(f.now.Add(30 * time.Second))
	renewed := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "keys", "renew_control", "release_control"}}
	transition(v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "2", Action: "renew_control", BrowserClientID: f.browser, LeaseID: &lease.LeaseID}, renewed)
	if f.control(t).Lease.ExpiresAt != lease.ExpiresAt {
		t.Fatal("renewal expiry missing")
	}
	suspended := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "3", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control", "resume_automation"}}
	transition(v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "2", Action: "release_control", BrowserClientID: f.browser, LeaseID: &lease.LeaseID}, suspended)
	if f.control(t).State != "suspended" {
		t.Fatal("release resumed automation")
	}
	automation := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "4", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	transition(v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "3", Action: "resume_automation", BrowserClientID: f.browser, DraftHandled: true}, automation)
	if f.control(t).State != "automation" || f.control(t).Lease != nil {
		t.Fatal("explicit automation handoff missing")
	}
}

func TestTerminalUnknownInitialDispositionAndAutomationHandoffAreSeparate(t *testing.T) {
	for _, initial := range []string{"unknown", "unconfirmed"} {
		t.Run(initial, func(t *testing.T) {
			f := terminalControlSetup(t)
			ctx := context.Background()
			err := terminalErrorStep(t, f.fixture, func() error {
				return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"SaveTerminal": 1}), func(phaseCtx context.Context) error {
					return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, f.message.SessionID, false, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
						r.ControlEpoch = "2"
						// An older Worker may advertise resume for unresolved delivery. The
						// service still rejects that decision until separate disposition.
						r.Control = &v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "suspended", InitialAssignment: initial, AvailableActions: []string{"acquire_control", "resolve_initial_assignment", "resume_automation"}}
						return saveTerminal(phaseCtx, tx, r)
					})
				})
			})
			if err != nil {
				t.Fatal(err)
			}
			resume := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "2", Action: "resume_automation", BrowserClientID: f.browser, DraftHandled: true}
			if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
					return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", resume))
				})
			}); err == nil {
				t.Fatal("automation resumed before the initial delivery decision")
			}
			disposition := "delivered_continue"
			resolve := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "2", Action: "resolve_initial_assignment", BrowserClientID: f.browser, InitialUnknownDisposition: &disposition}
			queued := f.submit(t, f.msg("control_request", resolve))
			if queued.Payload.(v2.OperationResult).State != "queued" || f.control(t).InitialAssignment != initial {
				t.Fatal("request acceptance replaced unconfirmed Worker state")
			}
			offers := f.poll(t, "1")
			if len(offers) != 1 || offers[0].Type != "control_dispatch" {
				t.Fatal(offers)
			}
			dispatch := offers[0].Payload.(v2.ControlDispatch)
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "3", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
			ack := v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(resolve.OperationID, "transport_completed", "")}
			if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalOperation": 1, "SetTerminalOperationResult": 1, "LockCredential": 2, "ProjectAccess": 2}), func(phaseCtx context.Context) (v2.Message, error) {
					return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("control_ack", ack))
				})
			}); err == nil {
				t.Fatal("disposition acknowledgement enabled automation")
			}
			ack.ControlState.State = "suspended"
			ack.ControlState.AvailableActions = []string{"acquire_control", "resume_automation"}
			f.worker(t, "1", f.msg("control_ack", ack))
			if got := f.control(t); got.State != "suspended" || got.InitialAssignment != "transport_completed" || got.Lease != nil {
				t.Fatal(got)
			}
			if got := f.submit(t, f.msg("control_request", resolve)).Payload.(v2.OperationResult); got.State != "transport_completed" || len(f.pollWith(t, "1", 0)) != 0 {
				t.Fatal("duplicate disposition created another dispatch")
			}
			resume.OperationID = uuid.NewString()
			resume.ControlEpoch = "3"
			f.submit(t, f.msg("control_request", resume))
			offers = f.poll(t, "1")
			if len(offers) != 1 || offers[0].Type != "control_dispatch" {
				t.Fatal(offers)
			}
			dispatch = offers[0].Payload.(v2.ControlDispatch)
			state.ControlEpoch = "4"
			f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(resume.OperationID, "transport_completed", "")}))
			if f.control(t).State != "automation" {
				t.Fatal("separate automation handoff was not accepted")
			}
		})
	}
}

func TestTerminalExpiredLeaseAndWrongBrowserCannotInput(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "guard")
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, input.SessionID, uuid.NewString(), input)
		})
	}); err == nil {
		t.Fatal("another browser reused the current lease")
	}
	f.now = f.now.Add(31 * time.Second)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, input.SessionID, f.browser, input)
		})
	}); err == nil {
		t.Fatal("expired lease accepted input")
	}
	// A read reconciles expiry and durably retains suspended instead of automation.
	var reconciled *v2.ControlState
	err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) error {
			return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, input.SessionID, false, func(tx *operationTx, r *terminalRecord, task task, _ bool) error {
				if err := f.s.refreshTerminalControl(phaseCtx, tx, r, task); err != nil {
					return err
				}
				reconciled = r.Control
				return nil
			})
		})
	})
	if err != nil || reconciled.Lease != nil || reconciled.State != "suspended" {
		t.Fatal(reconciled, err)
	}
}

func terminalOtherActor(t *testing.T, f *terminalControlFixture) model.Principal {
	t.Helper()
	return addMember(t, f.fixture, string(model.ProjectAdmin))
}

func TestTerminalRevokedActorIsRejectedBeforeForwardingAndAcknowledgement(t *testing.T) {
	for _, afterPoll := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued", true: "dispatched"}[afterPoll], func(t *testing.T) {
			f := terminalControlSetup(t)
			actor := listCredential(t, f.fixture, f.p.UserID, model.PATCredential)
			req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
			f.submitBy(t, actor, f.msg("control_request", req))
			var offers []v2.Message
			if afterPoll {
				offers = f.poll(t, "1")
			}
			revokeFixtureCredential(t, f.fixture, actor)
			if !afterPoll {
				if got := f.pollCounts(t, "1", 0, map[string]int{"ProjectAccess": 1}); len(got) != 0 {
					t.Fatal("revoked actor command was forwarded")
				}
			} else {
				d := offers[0].Payload.(v2.ControlDispatch)
				l := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
				state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &l, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
				f.workerWith(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}), map[string]int{"ProjectAccess": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 2})
			}
			if f.control(t).Lease != nil {
				t.Fatal("revoked actor received lease")
			}
		})
	}
}

func TestTerminalDisconnectAndLateAcknowledgementCannotReviveLease(t *testing.T) {
	f := terminalControlSetup(t)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	d := f.poll(t, "1")[0].Payload.(v2.ControlDispatch)
	f.operations.whenInvalidated(req.OperationID, "unknown", "input_unknown")
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	l := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &l, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), true, map[string]int{"TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
		})
	}); err == nil {
		t.Fatal("late ack replaced unknown outcome")
	}
	if f.control(t).Lease != nil {
		t.Fatal("late ack revived lease")
	}
}

func TestTerminalRenewAcknowledgementAfterOldExpiryDoesNotReviveLease(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	f.now = f.now.Add(29 * time.Second)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "2", Action: "renew_control", BrowserClientID: f.browser, LeaseID: &lease.LeaseID}
	f.submit(t, f.msg("control_request", req))
	d := f.poll(t, "1")[0].Payload.(v2.ControlDispatch)
	f.now = f.now.Add(2 * time.Second)
	lease.ExpiresAt = terminalTime(f.now.Add(30 * time.Second))
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "renew_control"}}
	f.workerWith(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}), map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2})
	if f.control(t).Lease != nil || f.control(t).State != "suspended" {
		t.Fatal("late renewal revived an expired lease")
	}
}

func TestTerminalActionRemovalBeforePollPreventsInput(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "disabled before offer")
	f.submit(t, input)
	state := *f.control(t)
	state.AvailableActions = []string{"keys", "release_control"}
	f.worker(t, "1", f.msg("control_state", state))
	if offers := f.pollWith(t, "1", 0); len(offers) != 0 {
		t.Fatal("removed action was still offered")
	}
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "rejected" {
		t.Fatal(got)
	}
}

func TestTerminalOperationTimeoutAtLateWorkerResultRemainsUnknown(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "uncertain input")
	f.submit(t, input)
	f.poll(t, "1")
	f.now = f.now.Add(11 * time.Second)
	got := f.worker(t, "1", f.msg("operation_result", terminalResult(input.Payload.(v2.Operation).OperationID, "transport_completed", "")))
	if got.Payload.(v2.OperationResult).State != "unknown" {
		t.Fatal("late result erased timeout")
	}
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "unknown" {
		t.Fatal(got)
	}
}

func TestTerminalInitialDeliveryStateCannotRegressOrResolveWithoutDisposition(t *testing.T) {
	for _, prior := range []string{"unknown", "unconfirmed", "transport_completed"} {
		if terminalInitialProgress(prior, "pending", nil) {
			t.Fatalf("%s became automatically sendable", prior)
		}
	}
	if !terminalInitialProgress("pending", "dispatching", nil) || !terminalInitialProgress("dispatching", "unknown", nil) || !terminalInitialProgress("dispatching", "pending", nil) {
		t.Fatal("valid initial delivery progression rejected")
	}
	request := v2.ControlRequest{Action: "resolve_initial_assignment"}
	if terminalInitialProgress("unknown", "transport_completed", &request) {
		t.Fatal("missing unknown disposition resolved delivery")
	}
	disposition := "delivered_continue"
	request.InitialUnknownDisposition = &disposition
	if !terminalInitialProgress("unknown", "transport_completed", &request) {
		t.Fatal("explicit initial disposition rejected")
	}
}

func TestTerminalInputRejectsStaleFencesTargetsSequencesAndActors(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	cases := map[string]func(*v2.Operation){
		"connection": func(o *v2.Operation) { o.ConnectionEpoch = "2" },
		"control":    func(o *v2.Operation) { o.ControlEpoch = "3" },
		"lease":      func(o *v2.Operation) { o.LeaseID = uuid.NewString() },
		"segment":    func(o *v2.Operation) { o.SegmentID = uuid.NewString() },
		"terminal":   func(o *v2.Operation) { o.Binding.TerminalID = "replacement" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			m := f.input(lease, "1", "guard")
			o := m.Payload.(v2.Operation)
			change(&o)
			m.Payload = o
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
					return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, m.SessionID, f.browser, m)
				})
			}); err == nil {
				t.Fatal("stale input accepted")
			}
		})
	}
	good := f.input(lease, "1", "accepted")
	f.submit(t, good)
	f.poll(t, "1")
	f.worker(t, "1", f.msg("operation_result", terminalResult(good.Payload.(v2.Operation).OperationID, "transport_completed", "")))
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"TerminalOperation": 1})), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, good.SessionID, f.browser, f.input(lease, "1", "reused sequence"))
		})
	}); err == nil {
		t.Fatal("duplicate lease sequence accepted")
	}
	actor := terminalOtherActor(t, f)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, actor, f.project, f.task, good.SessionID, f.browser, good)
		})
	}); err == nil {
		t.Fatal("another actor recovered original operation")
	}
	if _, err := terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, nil), func(phaseCtx context.Context) ([]v2.Message, error) {
		return f.s.PollTerminal(phaseCtx, actor, f.project, f.task, good.SessionID, f.message.Envelope, "1")
	}); err == nil {
		t.Fatal("another actor polled Worker channel")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, actor, f.project, f.task, good.SessionID, "1", f.msg("control_state", *f.control(t)))
		})
	}); err == nil {
		t.Fatal("another actor published Worker state")
	}
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, nil), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, actor, f.project, f.task, good.SessionID, f.message.Envelope, "1")
		})
	}); err == nil {
		t.Fatal("another actor disconnected Worker")
	}
	if _, err := terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, nil), func(phaseCtx context.Context) ([]v2.Message, error) {
		return f.s.PollTerminal(phaseCtx, f.p, f.project, f.task, good.SessionID, f.message.Envelope, "2")
	}); err == nil {
		t.Fatal("superseded epoch polled channel")
	}
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), true, nil), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminal(phaseCtx, f.p, f.project, f.task, good.SessionID, f.message.Envelope, "2")
		})
	}); err != nil {
		t.Fatal("stale disconnect affected current channel", err)
	}
	otherBrowser := uuid.NewString()
	f.operations.viewerBrowser = otherBrowser
	f.operations.viewerPending = false
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"TerminalViewerOperationPending": 1}), func(phaseCtx context.Context) error {
			return f.s.DisconnectTerminalViewer(phaseCtx, f.p, f.project, f.task, good.SessionID, otherBrowser, good.ClaimID, "1")
		})
	}); err != nil {
		t.Fatal(err)
	}
	if f.control(t).Lease == nil {
		t.Fatal("unrelated browser revoked active lease")
	}
}

func TestTerminalRejectsMalformedAndUnavailableControlWithoutLedgerWrite(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	malformed := f.msg("operation", nil)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, malformed)
		})
	}); err == nil {
		t.Fatal("nil payload accepted")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", malformed)
		})
	}); err == nil {
		t.Fatal("nil Worker payload accepted")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message)
		})
	}); err == nil {
		t.Fatal("registration used as operation")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.message)
		})
	}); err == nil {
		t.Fatal("registration used as control state")
	}
	wrong := req
	wrong.ConnectionEpoch = "2"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", wrong))
		})
	}); err == nil {
		t.Fatal("wrong epoch accepted")
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.dao.ContextPhase(ctx, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, uuid.NewString(), f.msg("control_request", req))
		})
	}); err == nil {
		t.Fatal("wrong browser accepted")
	}
	actor := terminalOtherActor(t, f)
	access := f.dao.ProjectAccessFn
	f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user == actor.UserID && project == f.project {
			return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectMemberRole}, nil
		}
		return access(ctx, user, project)
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, nil), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, actor, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req))
		})
	}); err == nil {
		t.Fatal("read-only project member issued control")
	}
	state := *f.control(t)
	state.AvailableActions = []string{}
	f.worker(t, "1", f.msg("control_state", state))
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req))
		})
	}); err == nil {
		t.Fatal("unavailable control action accepted")
	}
	state.AvailableActions = []string{"acquire_control"}
	f.worker(t, "1", f.msg("control_state", state))
	if err := terminalErrorStep(t, f.fixture, func() error {
		return terminalControlInputError(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"SaveTerminal": 1}), func(phaseCtx context.Context) error {
			return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, f.message.SessionID, false, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
				r.OperationSeq = maxSessionOperations
				return saveTerminal(phaseCtx, tx, r)
			})
		})
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1, "TerminalInputPending": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req))
		})
	}); err == nil {
		t.Fatal("ledger capacity exceeded")
	}
	if f.operations.insertCalls != 0 {
		t.Fatal("rejected controls attempted a ledger write", f.operations.insertCalls)
	}
}

func TestTerminalUnknownControlAcknowledgementSuspendsWithoutGranting(t *testing.T) {
	f := terminalControlSetup(t)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	d := f.poll(t, "1")[0].Payload.(v2.ControlDispatch)
	ack := v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: *f.control(t), Result: terminalResult(req.OperationID, "unknown", "input_unknown")}
	f.worker(t, "1", f.msg("control_ack", ack))
	f.worker(t, "1", f.msg("control_ack", ack))
	if f.control(t).State != "suspended" || f.control(t).Lease != nil {
		t.Fatal("unknown control outcome granted control")
	}
}

func TestTerminalInvalidAndRepeatedSnapshotHandling(t *testing.T) {
	f := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "2", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "a"}}}}}
	f.worker(t, "1", f.msg("snapshot", snapshot))
	f.worker(t, "1", f.msg("snapshot", snapshot))
	bad := snapshot
	bad.Frame.FrameSeq = "1"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", bad))
		})
	}); err == nil {
		t.Fatal("older preview replaced current frame")
	}
	bad = snapshot
	bad.ConnectionEpoch = "2"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", bad))
		})
	}); err == nil {
		t.Fatal("different preview epoch accepted")
	}
	state := *f.control(t)
	state.ControlEpoch = "2"
	f.worker(t, "1", f.msg("control_state", state))
	state.ControlEpoch = "1"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, f.refreshPhaseCounts(t)), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.HandleTerminalControl(phaseCtx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("control_state", state))
		})
	}); err == nil {
		t.Fatal("old control epoch accepted")
	}
}

func TestTerminalTransientBodyCapacityDoesNotEvictUnresolvedInput(t *testing.T) {
	s := &Execution{Engine: &Engine{}}
	for i := 0; i < maxLiveSessions; i++ {
		if err := storeTerminalTestBody(s, decimal(int64(i)), "operation", []byte("input")); err != nil {
			t.Fatal(err)
		}
	}
	if err := storeTerminalTestBody(s, "overflow", "operation", []byte("input")); err == nil {
		t.Fatal("unbounded pending body allocation")
	}
	if string(s.terminalBody("0", "operation")) != "input" {
		t.Fatal("capacity pressure evicted unresolved input")
	}
	s.forgetTerminalBody("0", "operation")
	if err := storeTerminalTestBody(s, "overflow", "operation", []byte("input")); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalActiveLeaseCredentialRevocationSuspendsAndInvalidatesInput(t *testing.T) {
	for _, revoke := range []string{"credential", "owner"} {
		t.Run(revoke, func(t *testing.T) {
			f := terminalControlSetup(t)
			actor := listCredential(t, f.fixture, f.p.UserID, model.PATCredential)
			req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
			f.submitBy(t, actor, f.msg("control_request", req))
			d := f.poll(t, "1")[0].Payload.(v2.ControlDispatch)
			lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "release_control"}}
			f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
			input := f.input(lease, "1", "revoke in flight")
			f.submitBy(t, actor, input)
			f.poll(t, "1")
			f.operations.whenInvalidated(input.Payload.(v2.Operation).OperationID, "unknown", "input_unknown")
			if revoke == "owner" {
				other := terminalOtherActor(t, f)
				if err := terminalErrorStep(t, f.fixture, func() error {
					return terminalControlInputError(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"SaveTerminal": 1}), func(phaseCtx context.Context) error {
						return f.s.terminalAccess(phaseCtx, f.p, f.project, f.task, f.message.SessionID, false, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
							r.ControlActor = &other
							return saveTerminal(phaseCtx, tx, r)
						})
					})
				}); err != nil {
					t.Fatal(err)
				}
				f.operations.operation(input.Payload.(v2.Operation).OperationID).Actor = other
			} else {
				revokeFixtureCredential(t, f.fixture, actor)
			}
			if _, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1, "TerminalArchive": 1, "LockCredential": 2, "ProjectAccess": map[string]int{"credential": 1, "owner": 2}[revoke]}), func(phaseCtx context.Context) (map[string]any, error) {
					return f.s.TerminalState(phaseCtx, f.p, f.project, f.task, f.message.SessionID)
				})
			}); err != nil {
				t.Fatal(err)
			}
			if f.control(t).State != "suspended" || f.control(t).Lease != nil {
				t.Fatal("revoked actor retained lease")
			}
			got, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "TerminalOperation": 1}), func(phaseCtx context.Context) (v2.Message, error) {
					return f.s.TerminalOperation(phaseCtx, f.p, f.project, f.task, f.message.SessionID, input.Payload.(v2.Operation).OperationID)
				})
			})
			if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
				t.Fatal(got, err)
			}
		})
	}
}

func TestTerminalIncompleteWorkerCapabilitiesCannotGrantControl(t *testing.T) {
	f := terminalControlSetup(t)
	reconnect := f.message
	registration := f.message.Payload.(v2.Registration)
	epoch := "1"
	registration.Mode = "reconnect"
	registration.ConnectionEpoch = &epoch
	registration.Capabilities.Archive = false
	reconnect.Payload = registration
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalRegistrationPhase(context.Background(), map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, reconnect)
		})
	}); err != nil {
		t.Fatal(err)
	}
	state := v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "2", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	f.worker(t, "2", f.msg("control_state", state))
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "2", ControlEpoch: "2", Action: "acquire_control", BrowserClientID: f.browser}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1}), func(phaseCtx context.Context) (v2.Message, error) {
			return f.s.SubmitTerminal(phaseCtx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req))
		})
	}); err == nil {
		t.Fatal("incomplete Worker granted control")
	}
	view, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		return terminalControlInputCall(f, f.fixture.TerminalPhase(context.Background(), false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}), func(phaseCtx context.Context) (map[string]any, error) {
			return f.s.TerminalState(phaseCtx, f.p, f.project, f.task, f.message.SessionID)
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view["control"].(*v2.ControlState).AvailableActions) != 0 {
		t.Fatal("incomplete Worker advertised browser control")
	}
}

func stageTerminalTestSnapshot(s *Execution, id string, raw []byte) (func(), func(), error) {
	if s.now == nil {
		s.now = time.Now
	}
	return s.stageTerminalSnapshot(&terminalRecord{Envelope: v2.Envelope{SessionID: id, ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}, raw)
}

func storeTerminalTestBody(s *Execution, id, operationID string, raw []byte) error {
	if s.now == nil {
		s.now = time.Now
	}
	_, err := s.storeTerminalBody(&terminalRecord{Envelope: v2.Envelope{SessionID: id, ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}, operationID, raw, s.now().Add(time.Duration(v2.InputTimeoutMillis)*time.Millisecond))
	return err
}

func terminalControlCall[T any](f fixture, phase context.Context, fn func(context.Context) (T, error)) (T, error) {
	defer f.dao.FinishContext(phase)
	return fn(phase)
}

func (f *terminalControlFixture) refreshPhaseCounts(t *testing.T) map[string]int {
	t.Helper()
	work := map[string]int{"ExpireTerminalOperations": 1}
	r := f.terminal.Record(t)
	if r.Control != nil && r.Control.Lease != nil {
		work["LockCredential"], work["ProjectAccess"] = 2, 2
	}
	return work
}

func (f *terminalControlFixture) workerPhaseCounts(t *testing.T, m v2.Message) map[string]int {
	t.Helper()
	r := f.terminal.Record(t)
	switch payload := m.Payload.(type) {
	case v2.ControlAck:
		op := f.operations.operation(payload.Result.OperationID)
		work := map[string]int{"TerminalOperation": 1, "SaveTerminal": 1}
		if !reflect.DeepEqual(op.Result, payload.Result) {
			work["SetTerminalOperationResult"] = 1
		}
		if op.Result.State == "dispatching" {
			if payload.Result.State == "unknown" || !f.now.Before(op.Deadline) {
				work["InvalidateTerminalOperations"], work["SaveTerminal"] = 1, 2
			} else if payload.Result.State == "transport_completed" {
				work["LockCredential"], work["ProjectAccess"] = 2, 2
			}
		}
		return work
	case v2.OperationResult:
		work := map[string]int{"TerminalOperation": 1}
		if !reflect.DeepEqual(f.operations.operation(payload.OperationID).Result, payload) {
			work["SetTerminalOperationResult"] = 1
		}
		return work
	case v2.ControlState:
		work := f.refreshPhaseCounts(t)
		work["SaveTerminal"] = 1
		if number(payload.ControlEpoch) > number(r.ControlEpoch) {
			work["InvalidateTerminalOperations"] = 1
		}
		return work
	case v2.Snapshot:
		return mergeFixtureCounts(f.refreshPhaseCounts(t), map[string]int{"SaveTerminal": 1})
	default:
		t.Fatalf("unsupported successful Worker phase: %s", m.Type)
		return nil
	}
}

func terminalControlError(f fixture, phase context.Context, fn func(context.Context) error) error {
	defer f.dao.FinishContext(phase)
	return fn(phase)
}

func terminalControlInputCall[T any](f *terminalControlFixture, phase context.Context, fn func(context.Context) (T, error)) (T, error) {
	f.operations.resetWrites()
	return terminalControlCall(f.fixture, phase, fn)
}

func terminalControlInputError(f *terminalControlFixture, phase context.Context, fn func(context.Context) error) error {
	f.operations.resetWrites()
	return terminalControlError(f.fixture, phase, fn)
}
