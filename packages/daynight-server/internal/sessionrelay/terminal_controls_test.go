package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strings"
	"testing"
	"time"
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

type terminalControlFixture struct {
	fixture
	message v2.Message
	binding v2.Binding
	segment string
	now     time.Time
	browser string
}

func terminalControlSetup(t *testing.T) *terminalControlFixture {
	t.Helper()
	f, m := terminalFixture(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	f.s.now = func() time.Time { return now }
	in := m.Payload.(v2.Registration)
	x := &terminalControlFixture{fixture: f, message: m, binding: in.Binding, segment: uuid.NewString(), now: now, browser: uuid.NewString()}
	f.s.now = func() time.Time { return x.now }
	if _, err := f.s.RegisterTerminal(context.Background(), f.p, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	run := v2.Run{ExecutionGeneration: "1", Owner: in.Owner, Binding: in.Binding, StartedAt: terminalTime(now), SegmentIDs: []string{x.segment}}
	m.Type = "generation_ledger"
	m.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := f.s.UpdateTerminalLedger(context.Background(), f.p, f.project, f.task, m.SessionID, "1", m); err != nil {
		t.Fatal(err)
	}
	m.Type = "recording_responsibility"
	m.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err := f.s.UpdateTerminalRecording(context.Background(), f.p, f.project, f.task, m.SessionID, "1", m); err != nil {
		t.Fatal(err)
	}
	x.worker(t, "1", x.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	return x
}
func (f *terminalControlFixture) msg(kind string, payload v2.Payload) v2.Message {
	m := f.message
	m.Type = kind
	m.Payload = payload
	return m
}
func (f *terminalControlFixture) worker(t *testing.T, epoch string, m v2.Message) v2.Message {
	t.Helper()
	out, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, m.SessionID, epoch, m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *terminalControlFixture) submit(t *testing.T, m v2.Message) v2.Message {
	t.Helper()
	out, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, m.SessionID, f.browser, m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *terminalControlFixture) poll(t *testing.T, epoch string) []v2.Message {
	t.Helper()
	out, err := f.s.PollTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, epoch)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f *terminalControlFixture) control(t *testing.T) *v2.ControlState {
	t.Helper()
	var out *v2.ControlState
	err := f.s.terminalAccess(context.Background(), f.p, f.project, f.task, f.message.SessionID, false, func(_ pgx.Tx, r *terminalRecord, _ task, _ bool) error { out = r.Control; return nil })
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
			if err := f.s.DisconnectTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1"); err != nil {
				t.Fatal(err)
			}
			if got := f.control(t); got.State != state {
				t.Fatalf("disconnect reopened terminal: %+v", got)
			}
			registration := f.message.Payload.(v2.Registration)
			registration.Mode = "reconnect"
			epoch := "1"
			registration.ConnectionEpoch = &epoch
			if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, f.msg("registration", registration)); err != nil {
				t.Fatal(err)
			}
			if got := f.control(t); got.State != state {
				t.Fatalf("reconnect reopened terminal: %+v", got)
			}
			for _, target := range []string{"suspended", "automation"} {
				m := f.msg("control_state", v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "4", State: target, InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}})
				if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, f.message.SessionID, "2", m); err == nil {
					t.Fatalf("%s reopened as %s", state, target)
				}
			}
		})
	}
}

func TestTerminalControlEpochExhaustionClosesWithoutOverflow(t *testing.T) {
	f := terminalControlSetup(t)
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "9223372036854775807", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{}}))
	if err := f.s.DisconnectTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1"); err != nil {
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
	err = x.s.terminalAccess(context.Background(), x.p, x.project, x.task, x.message.SessionID, false, func(_ pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		finalID := uuid.NewString()
		r.FinalizationID = &finalID
		if x.s.terminalSnapshot(r) != nil {
			t.Fatal("finalized record exposed cached frame")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTerminalSnapshotReservationsAreBoundedAndLatestCommitWins(t *testing.T) {
	s := &Service{}
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
	if _, err = f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, m.SessionID, "1", f.msg("snapshot", older)); err == nil {
		t.Fatal("older frame replaced a committed unpublished frame")
	}
	publish()
	f.s.forgetTerminalSnapshot(m.SessionID)
	changed := snapshot
	changed.Frame.Width = 2
	if _, err = f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, m.SessionID, "1", f.msg("snapshot", changed)); err == nil {
		t.Fatal("conflicting duplicate accepted after cache loss")
	}
	f.worker(t, "1", m)
	var persisted string
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, m.SessionID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(persisted, "newest private screen") {
		t.Fatal("frame content persisted with ordering metadata")
	}
	registration := f.message.Payload.(v2.Registration)
	registration.Mode = "reconnect"
	epoch := "1"
	registration.ConnectionEpoch = &epoch
	if _, err := f.s.RegisterTerminal(context.Background(), f.p, f.project, f.task, f.msg("registration", registration)); err != nil {
		t.Fatal(err)
	}
	snapshot.ConnectionEpoch = "2"
	f.worker(t, "2", f.msg("snapshot", snapshot))
	older.ConnectionEpoch = "2"
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, m.SessionID, "2", f.msg("snapshot", older)); err == nil {
		t.Fatal("reconnect reset the current segment's frame order")
	}
}

func TestTerminalExpiredHTTPPreviewsReleaseCapacityWithoutArchive(t *testing.T) {
	now := time.Now()
	s := &Service{now: func() time.Time { return now }}
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
	if _, err := f.s.DB.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DisconnectTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1"); err == nil {
		t.Fatal("revoked principal unexpectedly retained database permission")
	}
	if len(f.s.terminalFrames) != 0 {
		t.Fatal("revoked Worker disconnect retained preview")
	}
}

func TestTerminalPreviewReclamationPreservesActiveAndReservedConnections(t *testing.T) {
	now := time.Now()
	s := &Service{now: func() time.Time { return now }}
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
	s := &Service{now: time.Now}
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
	f.submit(t, f.input(lease, "1", "old input"))
	ctx := context.Background()
	native, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer native.Rollback(ctx)
	tx := &relayTx{Tx: native}
	r, err := loadTerminal(ctx, tx, f.message.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.suspendTerminal(ctx, tx, r); err != nil {
		t.Fatal(err)
	}
	if err = native.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// A new connection can submit after the commit releases the row lock, before
	// the suspended connection runs its in-memory cleanup callbacks.
	newID := uuid.NewString()
	if err = storeTerminalTestBody(f.s, f.message.SessionID, newID, []byte("new input")); err != nil {
		t.Fatal(err)
	}
	for _, cleanup := range tx.committed {
		cleanup()
	}
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
	actor := terminalOtherActor(t, f)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	if _, err := f.s.SubmitTerminal(context.Background(), actor, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DisconnectTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1"); err == nil {
		t.Fatal("revoked principal retained database permission")
	}
	if len(f.s.terminalPending) != 0 {
		t.Fatal("revoked original connection retained admin-submitted body")
	}
}

func TestTerminalBodyDeadlineMatchesLedgerAndRetainsUnexpiredInput(t *testing.T) {
	f := terminalControlSetup(t)
	f.now = f.now.Add(123 * time.Nanosecond)
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	f.submit(t, f.msg("control_request", req))
	var deadline time.Time
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, f.message.SessionID, req.OperationID).Scan(&deadline); err != nil {
		t.Fatal(err)
	}
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
	if offered := f.poll(t, "1"); len(offered) != 0 {
		t.Fatal("expired body was dispatched", offered)
	}
	result, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, f.message.SessionID, req.OperationID)
	if err != nil || result.Payload.(v2.OperationResult).State != "rejected" {
		t.Fatal("expiry did not retain durable rejection", result, err)
	}
}

func TestTerminalOldDisconnectPreservesNewConnectionBody(t *testing.T) {
	s := &Service{now: time.Now}
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
	got, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, f.message.SessionID, req.OperationID)
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
	native, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer native.Rollback(ctx)
	r, err := loadTerminal(ctx, native, m.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	cancelFailedWrite, err := f.s.storeTerminalBody(r, req.OperationID, encode(m), f.now.Add(time.Duration(v2.InputTimeoutMillis)*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	// SubmitTerminal releases the database row lock on rollback before its
	// caller can clean up the transient write. A same-ID retry can commit first.
	if err = native.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.submit(t, m).Payload.(v2.OperationResult); got.State != "queued" {
		t.Fatal(got)
	}
	cancelFailedWrite()
	if offered := f.poll(t, "1"); len(offered) != 1 || offered[0].Payload.(v2.ControlDispatch).Request.OperationID != req.OperationID {
		t.Fatal("rollback cleanup deleted the successfully retried body", offered)
	}
	if offered := f.poll(t, "1"); len(offered) != 0 {
		t.Fatal("successful retry was replayed", offered)
	}
}

func TestTerminalSuspensionOfRolledBackBodyCannotDeleteSameIDRetry(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	native, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer native.Rollback(ctx)
	r, err := loadTerminal(ctx, native, f.message.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.storeTerminalBody(r, req.OperationID, encode(f.msg("control_request", req)), f.now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err = native.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// A second transaction can suspend while the failed request's cache entry
	// remains. Its callback must capture that write, not just its reusable ID.
	native, err = f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer native.Rollback(ctx)
	tx := &relayTx{Tx: native}
	r, err = loadTerminal(ctx, tx, f.message.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.suspendTerminal(ctx, tx, r); err != nil {
		t.Fatal(err)
	}
	if err = native.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	req.ControlEpoch = "2"
	f.submit(t, f.msg("control_request", req))
	for _, cleanup := range tx.committed {
		cleanup()
	}
	if offered := f.poll(t, "1"); len(offered) != 1 || offered[0].Payload.(v2.ControlDispatch).Request.OperationID != req.OperationID {
		t.Fatal("suspension cleanup deleted a same-ID replacement", offered)
	}
}

func TestTerminalFailedInsertCancelsItsBodyAndPermitsRetry(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	if _, err := f.s.DB.Pool.Exec(ctx, `CREATE FUNCTION reject_terminal_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'operation insert refused'; END $$; CREATE TRIGGER reject_terminal_operation BEFORE INSERT ON session_operations FOR EACH ROW EXECUTE FUNCTION reject_terminal_operation()`); err != nil {
		t.Fatal(err)
	}
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
	m := f.msg("control_request", req)
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, m.SessionID, f.browser, m); err == nil {
		t.Fatal("injected insert failure unexpectedly committed")
	}
	if len(f.s.terminalPending) != 0 {
		t.Fatal("failed insert retained its body reservation")
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DROP TRIGGER reject_terminal_operation ON session_operations; DROP FUNCTION reject_terminal_operation()`); err != nil {
		t.Fatal(err)
	}
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
				other := New(f.s.DB)
				other.now = f.s.now
				ctx := context.Background()
				var before string
				if err := f.s.DB.Pool.QueryRow(ctx, `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, input.SessionID).Scan(&before); err != nil {
					t.Fatal(err)
				}
				var err error
				switch endpoint {
				case "current":
					_, err = other.CurrentTerminal(ctx, f.p, f.project, f.task)
				case "state":
					_, err = other.TerminalState(ctx, f.p, f.project, f.task, input.SessionID)
				case "operation":
					_, err = other.TerminalOperation(ctx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
				case "submit":
					_, err = other.SubmitTerminal(ctx, f.p, f.project, f.task, input.SessionID, f.browser, f.input(lease, "2", "wrong relay"))
				}
				var after string
				if readErr := f.s.DB.Pool.QueryRow(ctx, `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, input.SessionID).Scan(&after); readErr != nil {
					t.Fatal(readErr)
				}
				if before != after {
					t.Fatal("foreign relay mutated healthy original control state")
				}
				var refusal *service.Fault
				if !errors.As(err, &refusal) || refusal.Code != "relay_instance_unavailable" {
					t.Fatalf("missing explicit relay routing refusal: %v", err)
				}
				got, readErr := f.s.TerminalOperation(ctx, f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
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
			other := New(f.s.DB)
			other.now, other.Origin = f.s.now, f.s.Origin
			registration := f.message.Payload.(v2.Registration)
			registration.Mode = "reconnect"
			epoch := "1"
			registration.ConnectionEpoch = &epoch
			_, err := other.RegisterTerminal(context.Background(), f.p, f.project, f.task, f.msg("registration", registration))
			var refusal *service.Fault
			if !errors.As(err, &refusal) || refusal.Code != "input_busy" {
				t.Fatalf("healthy foreign registration bypassed existing owner: %v", err)
			}
			if cause == "heartbeat_timeout" {
				f.now = f.now.Add(HeartbeatTimeout + time.Second)
			} else {
				archiveTerminal(t, f.fixture)
			}
			if _, err := other.TerminalState(context.Background(), f.p, f.project, f.task, input.SessionID); err != nil {
				t.Fatal(err)
			}
			if control := f.control(t); control.State != "suspended" || control.Lease != nil || control.ControlEpoch != "3" {
				t.Fatal("lost owner retained manual control", control)
			}
			got, err := other.TerminalOperation(context.Background(), f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
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
					f.s = New(original.DB)
					f.s.now, f.s.Origin = original.now, original.Origin
				}
				f.now = f.now.Add(HeartbeatTimeout + time.Second)
				reg := f.message.Payload.(v2.Registration)
				reg.Mode = "reconnect"
				previous := "1"
				reg.ConnectionEpoch = &previous
				if _, err := f.s.RegisterTerminal(context.Background(), f.p, f.project, f.task, f.msg("registration", reg)); err != nil {
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
				var before, after string
				ctx := context.Background()
				if err := original.DB.Pool.QueryRow(ctx, `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, f.message.SessionID).Scan(&before); err != nil {
					t.Fatal(err)
				}
				if err := original.DisconnectTerminalViewer(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1"); err != nil {
					t.Fatal(err)
				}
				if err := original.DB.Pool.QueryRow(ctx, `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, f.message.SessionID).Scan(&after); err != nil {
					t.Fatal(err)
				}
				if before != after {
					t.Fatal("old viewer revoked reconnected Worker state")
				}
				got, err := f.s.TerminalOperation(ctx, f.p, f.project, f.task, f.message.SessionID, opID)
				if err != nil || got.Payload.(v2.OperationResult).State != "queued" {
					t.Fatal("old viewer rejected the new operation", got, err)
				}
				if err := f.s.DisconnectTerminalViewer(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "2"); err != nil {
					t.Fatal(err)
				}
				got, err = f.s.TerminalOperation(ctx, f.p, f.project, f.task, f.message.SessionID, opID)
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
	if err := f.s.terminalAccess(ctx, f.p, f.project, f.task, f.message.SessionID, false, func(_ pgx.Tx, r *terminalRecord, _ task, _ bool) error { run = r.Runs[0]; return nil }); err != nil {
		t.Fatal(err)
	}
	stopped := terminalTime(f.now)
	run.StoppedAt = &stopped
	run.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	f.message.ExecutionGeneration = "2"
	newRun := v2.Run{ExecutionGeneration: "2", Owner: run.Owner, Binding: binding, StartedAt: stopped, SegmentIDs: []string{uuid.NewString()}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("generation_ledger", v2.GenerationLedger{Runs: []v2.Run{run, newRun}})); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, f.message.SessionID, "1", f.msg("recording_responsibility", v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true})); err != nil {
		t.Fatal(err)
	}
	f.worker(t, "1", f.msg("control_state", v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}))
	f.acquire(t)
	if err := f.s.DisconnectTerminalViewer(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1"); err != nil {
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
	err := f.s.terminalAccess(context.Background(), f.p, f.project, f.task, f.message.SessionID, false, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		r.Runs[0].SegmentIDs = append(r.Runs[0].SegmentIDs, uuid.NewString())
		return saveTerminal(context.Background(), tx, r)
	})
	if err != nil {
		t.Fatal(err)
	}
	if offered := f.poll(t, "1"); len(offered) != 0 {
		t.Fatal("input offered to a prior segment", offered)
	}
	out, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, f.message.SessionID, input.Payload.(v2.Operation).OperationID)
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
	if len(f.poll(t, "1")) != 0 {
		t.Fatal("control request replayed")
	}
	dispatch := offers[0].Payload.(v2.ControlDispatch)
	if dispatch.ActorUserID != f.p.UserID || dispatch.Request != req {
		t.Fatal(dispatch)
	}
	lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "keys", "renew_control", "release_control"}}
	if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, request.SessionID, "1", f.msg("control_state", state)); err == nil {
		t.Fatal("unsolicited manual state granted lease")
	}
	ack := v2.ControlAck{RequestDigest: dispatch.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}
	wrong := ack
	wrong.RequestDigest = strings.Repeat("0", 64)
	if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, request.SessionID, "1", f.msg("control_ack", wrong)); err == nil {
		t.Fatal("uncorrelated durable acknowledgement accepted")
	}
	f.worker(t, "1", f.msg("control_ack", ack))
	if got := f.control(t).Lease; got == nil || *got != lease {
		t.Fatal(got)
	}
	input := f.input(lease, "1", "private-terminal-paste")
	f.submit(t, input)
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, input.SessionID, f.browser, f.input(lease, "2", "other")); err == nil {
		t.Fatal("second unresolved batch accepted")
	}
	var persisted string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT command::text FROM session_operations WHERE session_id=$1 AND operation_id=$2`, input.SessionID, input.Payload.(v2.Operation).OperationID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(persisted, "private-terminal-paste") {
		t.Fatal("native paste persisted in the server control ledger")
	}
	offers = f.poll(t, "1")
	if len(offers) != 1 || offers[0].Payload.(v2.Operation).Payload.(v2.Paste).Text != "private-terminal-paste" {
		t.Fatal(offers)
	}
	if len(f.poll(t, "1")) != 0 {
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
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, input.SessionID, f.browser, changed); err == nil {
		t.Fatal("same operation ID accepted different body")
	}
	if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, input.SessionID, "1", f.msg("operation_result", terminalResult(opID, "transport_completed", ""))); err == nil {
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
	got, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, input.SessionID, input.Payload.(v2.Operation).OperationID)
	if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
		t.Fatal(got, err)
	}
	reconnect := f.message
	registration := f.message.Payload.(v2.Registration)
	epoch := "1"
	registration.Mode = "reconnect"
	registration.ConnectionEpoch = &epoch
	reconnect.Payload = registration
	ack, err := f.s.RegisterTerminal(context.Background(), f.p, f.project, f.task, reconnect)
	if err != nil || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack, err)
	}
	if f.control(t).Lease != nil || f.control(t).State != "suspended" {
		t.Fatal("reconnect revived control")
	}
	if got := f.submit(t, input).Payload.(v2.OperationResult); got.State != "unknown" {
		t.Fatal(got)
	}
	if len(f.poll(t, "2")) != 0 {
		t.Fatal("reconnect replayed input")
	}
	state := v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "3", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	if _, err = f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, input.SessionID, "2", f.msg("control_state", state)); err == nil {
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
	if len(f.poll(t, "1")) != 0 {
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
	if err := f.s.DisconnectTerminalViewer(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.browser, f.message.ClaimID, "1"); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, f.message.SessionID, req.OperationID)
	if err != nil || got.Payload.(v2.OperationResult).State != "unknown" {
		t.Fatal(got, err)
	}
}

func TestTerminalSnapshotIsTransientAndBoundToRegisteredSegment(t *testing.T) {
	f := terminalControlSetup(t)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "private-screen"}}}}}
	f.worker(t, "1", f.msg("snapshot", snapshot))
	var persisted string
	if err := f.s.DB.Pool.QueryRow(context.Background(), `SELECT terminal_state::text FROM task_sessions WHERE id=$1`, f.message.SessionID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
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
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", snapshot)); err == nil {
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

func TestTerminalExpiredLeaseAndWrongBrowserCannotInput(t *testing.T) {
	f := terminalControlSetup(t)
	lease := f.acquire(t)
	input := f.input(lease, "1", "guard")
	if _, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, input.SessionID, uuid.NewString(), input); err == nil {
		t.Fatal("another browser reused the current lease")
	}
	f.now = f.now.Add(31 * time.Second)
	if _, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, input.SessionID, f.browser, input); err == nil {
		t.Fatal("expired lease accepted input")
	}
	// A read reconciles expiry and durably retains suspended instead of automation.
	var reconciled *v2.ControlState
	err := f.s.terminalAccess(context.Background(), f.p, f.project, f.task, input.SessionID, false, func(tx pgx.Tx, r *terminalRecord, task task, _ bool) error {
		if err := f.s.refreshTerminalControl(context.Background(), tx, r, task); err != nil {
			return err
		}
		reconciled = r.Control
		return nil
	})
	if err != nil || reconciled.Lease != nil || reconciled.State != "suspended" {
		t.Fatal(reconciled, err)
	}
}

func terminalOtherActor(t *testing.T, f *terminalControlFixture) core.Principal {
	t.Helper()
	p := core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(p.CredentialID))
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{p.UserID, p.UserID}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'terminal actor',now(),now()+interval '1 day')`, []any{p.CredentialID, p.UserID, hash[:]}},
		{`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.project, p.UserID}},
	}
	for _, q := range statements {
		if _, err := f.s.DB.Pool.Exec(context.Background(), q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestTerminalRevokedActorIsRejectedBeforeForwardingAndAcknowledgement(t *testing.T) {
	for _, afterPoll := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued", true: "dispatched"}[afterPoll], func(t *testing.T) {
			f := terminalControlSetup(t)
			actor := terminalOtherActor(t, f)
			req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
			if _, err := f.s.SubmitTerminal(context.Background(), actor, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err != nil {
				t.Fatal(err)
			}
			var offers []v2.Message
			if afterPoll {
				offers = f.poll(t, "1")
			}
			if _, err := f.s.DB.Pool.Exec(context.Background(), `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
				t.Fatal(err)
			}
			if !afterPoll {
				if got := f.poll(t, "1"); len(got) != 0 {
					t.Fatal("revoked actor command was forwarded")
				}
			} else {
				d := offers[0].Payload.(v2.ControlDispatch)
				l := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
				state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &l, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
				f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
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
	if err := f.s.DisconnectTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1"); err != nil {
		t.Fatal(err)
	}
	l := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: f.p.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
	state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &l, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, f.message.SessionID, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")})); err == nil {
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
	f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
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
	if offers := f.poll(t, "1"); len(offers) != 0 {
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
	request := v2.ControlRequest{Action: "resume_automation", DraftHandled: true}
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
			if _, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, m.SessionID, f.browser, m); err == nil {
				t.Fatal("stale input accepted")
			}
		})
	}
	good := f.input(lease, "1", "accepted")
	f.submit(t, good)
	f.poll(t, "1")
	f.worker(t, "1", f.msg("operation_result", terminalResult(good.Payload.(v2.Operation).OperationID, "transport_completed", "")))
	if _, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, good.SessionID, f.browser, f.input(lease, "1", "reused sequence")); err == nil {
		t.Fatal("duplicate lease sequence accepted")
	}
	actor := terminalOtherActor(t, f)
	if _, err := f.s.SubmitTerminal(context.Background(), actor, f.project, f.task, good.SessionID, f.browser, good); err == nil {
		t.Fatal("another actor recovered original operation")
	}
	if _, err := f.s.PollTerminal(context.Background(), actor, f.project, f.task, good.SessionID, f.message.Envelope, "1"); err == nil {
		t.Fatal("another actor polled Worker channel")
	}
	if _, err := f.s.HandleTerminalControl(context.Background(), actor, f.project, f.task, good.SessionID, "1", f.msg("control_state", *f.control(t))); err == nil {
		t.Fatal("another actor published Worker state")
	}
	if err := f.s.DisconnectTerminal(context.Background(), actor, f.project, f.task, good.SessionID, f.message.Envelope, "1"); err == nil {
		t.Fatal("another actor disconnected Worker")
	}
	if _, err := f.s.PollTerminal(context.Background(), f.p, f.project, f.task, good.SessionID, f.message.Envelope, "2"); err == nil {
		t.Fatal("superseded epoch polled channel")
	}
	if err := f.s.DisconnectTerminal(context.Background(), f.p, f.project, f.task, good.SessionID, f.message.Envelope, "2"); err != nil {
		t.Fatal("stale disconnect affected current channel", err)
	}
	if err := f.s.DisconnectTerminalViewer(context.Background(), f.p, f.project, f.task, good.SessionID, uuid.NewString(), good.ClaimID, "1"); err != nil {
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
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, malformed); err == nil {
		t.Fatal("nil payload accepted")
	}
	if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, f.message.SessionID, "1", malformed); err == nil {
		t.Fatal("nil Worker payload accepted")
	}
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.message); err == nil {
		t.Fatal("registration used as operation")
	}
	if _, err := f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, f.message.SessionID, "1", f.message); err == nil {
		t.Fatal("registration used as control state")
	}
	wrong := req
	wrong.ConnectionEpoch = "2"
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", wrong)); err == nil {
		t.Fatal("wrong epoch accepted")
	}
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, uuid.NewString(), f.msg("control_request", req)); err == nil {
		t.Fatal("wrong browser accepted")
	}
	actor := terminalOtherActor(t, f)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitTerminal(ctx, actor, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err == nil {
		t.Fatal("read-only project member issued control")
	}
	state := *f.control(t)
	state.AvailableActions = []string{}
	f.worker(t, "1", f.msg("control_state", state))
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err == nil {
		t.Fatal("unavailable control action accepted")
	}
	state.AvailableActions = []string{"acquire_control"}
	f.worker(t, "1", f.msg("control_state", state))
	if err := f.s.terminalAccess(ctx, f.p, f.project, f.task, f.message.SessionID, false, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		r.OperationSeq = maxSessionOperations
		return saveTerminal(ctx, tx, r)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err == nil {
		t.Fatal("ledger capacity exceeded")
	}
	var count int
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1`, f.message.SessionID).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
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
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", bad)); err == nil {
		t.Fatal("older preview replaced current frame")
	}
	bad = snapshot
	bad.ConnectionEpoch = "2"
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, f.message.SessionID, "1", f.msg("snapshot", bad)); err == nil {
		t.Fatal("different preview epoch accepted")
	}
	state := *f.control(t)
	state.ControlEpoch = "2"
	f.worker(t, "1", f.msg("control_state", state))
	state.ControlEpoch = "1"
	if _, err := f.s.HandleTerminalControl(context.Background(), f.p, f.project, f.task, f.message.SessionID, "1", f.msg("control_state", state)); err == nil {
		t.Fatal("old control epoch accepted")
	}
}

func TestTerminalTransientBodyCapacityDoesNotEvictUnresolvedInput(t *testing.T) {
	s := &Service{}
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
	for _, revoke := range []string{"credential", "role"} {
		t.Run(revoke, func(t *testing.T) {
			f := terminalControlSetup(t)
			actor := terminalOtherActor(t, f)
			req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
			if _, err := f.s.SubmitTerminal(context.Background(), actor, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err != nil {
				t.Fatal(err)
			}
			d := f.poll(t, "1")[0].Payload.(v2.ControlDispatch)
			lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste", "release_control"}}
			f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: d.RequestDigest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
			input := f.input(lease, "1", "revoke in flight")
			if _, err := f.s.SubmitTerminal(context.Background(), actor, f.project, f.task, f.message.SessionID, f.browser, input); err != nil {
				t.Fatal(err)
			}
			f.poll(t, "1")
			sql := `DELETE FROM personal_access_tokens WHERE id=$1`
			args := []any{actor.CredentialID}
			if revoke == "role" {
				sql = `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`
				args = []any{f.project, actor.UserID}
			}
			if _, err := f.s.DB.Pool.Exec(context.Background(), sql, args...); err != nil {
				t.Fatal(err)
			}
			if _, err := f.s.TerminalState(context.Background(), f.p, f.project, f.task, f.message.SessionID); err != nil {
				t.Fatal(err)
			}
			if f.control(t).State != "suspended" || f.control(t).Lease != nil {
				t.Fatal("revoked actor retained lease")
			}
			got, err := f.s.TerminalOperation(context.Background(), f.p, f.project, f.task, f.message.SessionID, input.Payload.(v2.Operation).OperationID)
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
	if _, err := f.s.RegisterTerminal(context.Background(), f.p, f.project, f.task, reconnect); err != nil {
		t.Fatal(err)
	}
	state := v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "2", State: "suspended", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	f.worker(t, "2", f.msg("control_state", state))
	req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "2", ControlEpoch: "2", Action: "acquire_control", BrowserClientID: f.browser}
	if _, err := f.s.SubmitTerminal(context.Background(), f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req)); err == nil {
		t.Fatal("incomplete Worker granted control")
	}
	view, err := f.s.TerminalState(context.Background(), f.p, f.project, f.task, f.message.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(view["control"].(*v2.ControlState).AvailableActions) != 0 {
		t.Fatal("incomplete Worker advertised browser control")
	}
}

func stageTerminalTestSnapshot(s *Service, id string, raw []byte) (func(), func(), error) {
	if s.now == nil {
		s.now = time.Now
	}
	return s.stageTerminalSnapshot(&terminalRecord{Envelope: v2.Envelope{SessionID: id, ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}, raw)
}

func storeTerminalTestBody(s *Service, id, operationID string, raw []byte) error {
	if s.now == nil {
		s.now = time.Now
	}
	_, err := s.storeTerminalBody(&terminalRecord{Envelope: v2.Envelope{SessionID: id, ClaimID: "claim", ExecutionGeneration: "1"}, ConnectionEpoch: "1", Owner: v2.Owner{OwnerUserID: "owner"}}, operationID, raw, s.now().Add(time.Duration(v2.InputTimeoutMillis)*time.Millisecond))
	return err
}
