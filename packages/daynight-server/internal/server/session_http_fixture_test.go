package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sessionHTTPStore struct {
	*httpTestStore
	fixture *sessionHTTPFixture
}

type sessionHTTPScope struct {
	t   *testing.T
	dao store.SessionDAO
}

func (s sessionHTTPScope) SessionDAO() store.SessionDAO { return s.dao }
func (s sessionHTTPScope) BotDAO() store.BotWriteDAO    { return sessionHTTPRejectedBotDAO{t: s.t} }

type sessionHTTPWrites struct {
	session          *store.SessionRecord
	grant            *store.SessionGrant
	instance         string
	seen             *time.Time
	connectionExpiry *time.Time
	disconnected     int
	operations       []store.SessionOperation
	receipts         []sp.Operation
	epochs           []struct {
		id    string
		epoch int64
	}
}

type sessionHTTPDAO struct {
	ctx context.Context
	sessionHTTPRejectedDAO
	t             *testing.T
	f             *sessionHTTPFixture
	record        store.SessionRecord
	task          store.SessionTask
	operations    []store.SessionOperation
	intentIDs     []string
	queryRevision int64
	calls         map[string]int
	first         string
}

func sessionHTTPCopy[T any](v T) T {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (s *sessionHTTPStore) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	f := s.fixture
	f.mu.Lock()
	d := &sessionHTTPDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: s.t}, t: s.t, ctx: ctx, f: f, record: sessionHTTPCopy(f.record), task: sessionHTTPCopy(f.sessionTask), operations: sessionHTTPCopy(f.operations), intentIDs: append([]string(nil), f.intentIDs...), queryRevision: f.queryRevision, calls: map[string]int{}}
	f.mu.Unlock()
	err := fn(sessionHTTPScope{t: s.t, dao: d})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	d.verify()
	if d.calls["ConnectSession"] == 1 {
		f.mu.Lock()
		commit := f.connectionCommit
		f.mu.Unlock()
		if commit == nil {
			d.fail("connection commit has no test barrier")
		}
		select {
		case <-commit:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (d *sessionHTTPDAO) called(ctx context.Context, name string) {
	if ctx != d.ctx {
		d.fail("Session DAO %s escaped transaction context", name)
	}
	if d.first == "" {
		d.first = name
	}
	d.calls[name]++
	d.f.mu.Lock()
	d.f.calls[name]++
	d.f.mu.Unlock()
}
func (d *sessionHTTPDAO) fail(format string, args ...any) {
	d.t.Helper()
	d.t.Errorf(format, args...)
	panic(fmt.Sprintf(format, args...))
}
func (d *sessionHTTPDAO) id(id string) {
	if id != d.record.Snapshot.SessionID {
		d.fail("Session DAO id=%q, want %q", id, d.record.Snapshot.SessionID)
	}
}
func (d *sessionHTTPDAO) verify() {
	required := map[string]int{}
	switch d.first {
	case "ListSessionMediaLeases":
		if len(d.calls) != 1 || d.calls["ListSessionMediaLeases"] != 1 {
			d.fail("media recovery listing retained or reused its database scope")
		}
		return
	case "LockTaskRegistration":
		required = map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1}
	case "SessionLocation":
		required = map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "SessionLocationByGrant":
		required = map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "LockTask", "LockArchiveTask":
		required = map[string]int{d.first: 1, "LockCredential": 1, "ProjectAccess": 1}
	default:
		d.fail("unconfigured Session transaction begins with %q", d.first)
	}
	// Each offered operation rechecks its submitting authority within its callback.
	if d.first == "SessionLocation" && d.calls["SessionOperation"] != 0 {
		required["LockCredential"] += d.calls["SessionOperation"]
		required["ProjectAccess"] += d.calls["SessionOperation"]
	}
	for name, n := range required {
		if d.calls[name] != n {
			d.fail("Session callback %s=%d, want %d (first=%s)", name, d.calls[name], n, d.first)
		}
	}
	if d.calls["SessionBotID"] != d.calls["LockSession"] {
		d.fail("Session lookup and lock count differ")
	}
	for _, name := range []string{"SaveSession", "TouchSession", "DisconnectSession", "ConnectSession", "SetSessionGrant", "SetSessionGenerationStop", "InsertSessionOperation", "AcceptedSessionOperations", "CurrentTaskSession", "PendingSessionOperationCount", "UnreconciledSessionOperationCount"} {
		if d.calls[name] > 1 {
			d.fail("extra Session callback %s", name)
		}
	}
	if d.calls["TouchSession"] != 0 || d.calls["ConnectSession"] != 0 || d.calls["DisconnectSession"] != 0 || d.calls["SetSessionGrant"] != 0 || d.calls["InsertSessionOperation"] != 0 || d.calls["SetSessionOperationReceipt"] != 0 {
		if d.calls["SaveSession"] != 1 {
			d.fail("Session callback omitted exact SaveSession")
		}
	}
	if d.calls["PendingSessionOperationCount"] != 0 && d.calls["InsertSessionOperation"] != 1 {
		d.fail("accepted command did not insert exact operation")
	}
	for _, name := range []string{"SetSessionOperationReceipt", "SetSessionOperationEpoch"} {
		if d.calls[name] > d.calls["SessionOperation"] {
			d.fail("extra %s compared with selected operation reads", name)
		}
	}

}
func (d *sessionHTTPDAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	d.called(ctx, "ListSessionMediaLeases")
	d.f.mu.Lock()
	read := d.f.mediaRecoveryRead
	d.f.mu.Unlock()
	if read == nil {
		d.fail("unconfigured media recovery lease listing")
	}
	return read(ctx)
}

func (d *sessionHTTPDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.called(ctx, "LockCredential")
	if now.IsZero() || p != d.f.handler.principal {
		d.fail("Session credential changed principal or time: %+v", p)
	}
	d.f.mu.Lock()
	revoked := d.f.credentialRevoked
	d.f.mu.Unlock()
	if revoked {
		return model.ErrNotFound
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.called(ctx, "ProjectAccess")
	if user != d.f.handler.principal.UserID || project != d.f.task.ProjectID {
		d.fail("Session project access args %q/%q", user, project)
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, ctx.Err()
}
func (d *sessionHTTPDAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session Task lock changed address %q/%q", project, id)
	}
	return d.task, ctx.Err()
}
func (d *sessionHTTPDAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	d.called(ctx, "LockArchiveTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session archive Task lock changed address")
	}
	return d.task, false, ctx.Err()
}
func (d *sessionHTTPDAO) LockTaskRegistration(ctx context.Context, project, id string) error {
	d.called(ctx, "LockTaskRegistration")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("registration lock changed address")
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) FindTaskRegistration(ctx context.Context, project, registration, task, claim string) (string, error) {
	d.called(ctx, "FindTaskRegistration")
	if project != d.f.task.ProjectID || task != d.f.task.ID || registration != d.f.registration.RegistrationID || claim != d.f.registration.ClaimID {
		d.fail("registration lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionHTTPDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.called(ctx, "SessionBotID")
	d.id(id)
	return nil, ctx.Err()
}
func (d *sessionHTTPDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.called(ctx, "LockSession")
	d.id(id)
	return d.record, ctx.Err()
}
func (d *sessionHTTPDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocation")
	d.id(id)
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: id}, ctx.Err()
}
func (d *sessionHTTPDAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocationByGrant")
	if !bytes.Equal(hash, d.record.GrantHash) {
		return store.SessionLocation{}, model.ErrNotFound
	}
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: d.record.Snapshot.SessionID}, ctx.Err()
}
func (d *sessionHTTPDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.called(ctx, "CurrentTaskSession")
	if project != d.f.task.ProjectID || task != d.f.task.ID || claim != d.record.Snapshot.ClaimID {
		d.fail("current Session lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionHTTPDAO) SaveSession(ctx context.Context, in store.SessionRecord) error {
	d.called(ctx, "SaveSession")
	d.id(in.Snapshot.SessionID)
	if in.Snapshot.ClaimID != d.record.Snapshot.ClaimID || in.Snapshot.Identity.ProjectID != d.f.task.ProjectID || in.Snapshot.Identity.TaskID != d.f.task.ID {
		d.fail("saved Session changed owner binding")
	}
	d.f.mu.Lock()
	d.f.writes.session = new(sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionGrant(ctx context.Context, in store.SessionGrant) error {
	d.called(ctx, "SetSessionGrant")
	d.id(in.SessionID)
	if in.ParentCredentialID != d.f.handler.principal.CredentialID || len(in.Hash) != 32 || in.ExpiresAt.IsZero() {
		d.fail("grant changed parent or token hash")
	}
	d.f.mu.Lock()
	d.f.writes.grant = new(sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionGenerationStop(ctx context.Context, id string, proof []byte) error {
	d.called(ctx, "SetSessionGenerationStop")
	d.id(id)
	if !json.Valid(proof) {
		d.fail("generation stop is not JSON")
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) ConnectSession(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
	d.called(ctx, "ConnectSession")
	d.id(id)
	if instance == "" || seen.IsZero() || expiry == nil || !expiry.Equal(*d.record.GrantExpiry) {
		d.fail("connection changed instance/time/grant expiry")
	}
	d.f.mu.Lock()
	d.f.writes.instance = instance
	d.f.writes.seen = &seen
	d.f.writes.connectionExpiry = expiry
	captured := d.f.connectionCaptured
	d.f.mu.Unlock()
	if captured == nil {
		d.fail("connection capture has no test barrier")
	}
	close(captured)
	return ctx.Err()
}
func (d *sessionHTTPDAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	d.called(ctx, "TouchSession")
	d.id(id)
	if now.IsZero() {
		d.fail("heartbeat time is zero")
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) DisconnectSession(ctx context.Context, id string) error {
	d.called(ctx, "DisconnectSession")
	d.id(id)
	if op, err := d.f.application.engine.BeginOperation(); err != nil {
		d.fail("engine stopped before controller disconnect: %v", err)
	} else {
		op.Close()
	}
	d.f.mu.Lock()
	d.f.writes.disconnected++
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SessionOperation(ctx context.Context, session, id string) (store.SessionOperation, error) {
	d.called(ctx, "SessionOperation")
	d.id(session)
	for _, o := range d.operations {
		if o.OperationID == id {
			return o, ctx.Err()
		}
	}
	for _, expected := range d.intentIDs {
		if expected == id {
			return store.SessionOperation{}, model.ErrNotFound
		}
	}
	d.fail("unconfigured operation lookup %q", id)
	return store.SessionOperation{}, model.ErrNotFound
}
func (d *sessionHTTPDAO) InsertSessionOperation(ctx context.Context, in store.SessionOperation) error {
	d.called(ctx, "InsertSessionOperation")
	d.id(in.SessionID)
	if in.Actor != d.f.handler.principal || in.OperationID != in.Command.OperationID || in.Receipt.OperationID != in.OperationID || in.Receipt.State != "accepted" || len(in.Hash) != 32 {
		d.fail("operation insert changed actor, identity or receipt")
	}
	d.f.mu.Lock()
	d.f.writes.operations = append(d.f.writes.operations, sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionOperationReceipt(ctx context.Context, in sp.Operation) error {
	d.called(ctx, "SetSessionOperationReceipt")
	if in.SessionID != d.record.Snapshot.SessionID || in.ClaimID != d.record.Snapshot.ClaimID {
		d.fail("receipt changed Session fence")
	}
	selected := false
	for _, o := range d.operations {
		if o.OperationID == in.OperationID {
			selected = true
		}
	}
	if !selected {
		d.fail("receipt targeted unconfigured operation")
	}
	d.f.mu.Lock()
	d.f.writes.receipts = append(d.f.writes.receipts, sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionOperationEpoch(ctx context.Context, session, id string, epoch int64) error {
	d.called(ctx, "SetSessionOperationEpoch")
	d.id(session)
	if epoch <= 0 {
		d.fail("operation epoch not positive")
	}
	selected := false
	for _, o := range d.operations {
		if o.OperationID == id {
			selected = true
		}
	}
	if !selected {
		d.fail("epoch targeted unconfigured operation")
	}
	d.f.mu.Lock()
	d.f.writes.epochs = append(d.f.writes.epochs, struct {
		id    string
		epoch int64
	}{id, epoch})
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) HasOtherFirstInput(ctx context.Context, session, id string) (bool, error) {
	d.called(ctx, "HasOtherFirstInput")
	d.id(session)
	return false, ctx.Err()
}
func (d *sessionHTTPDAO) HasInteractionResponse(ctx context.Context, session, id, interaction string) (bool, error) {
	d.called(ctx, "HasInteractionResponse")
	d.id(session)
	return false, ctx.Err()
}
func (d *sessionHTTPDAO) PendingSessionOperationCount(ctx context.Context, id string) (int, error) {
	d.called(ctx, "PendingSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}
func (d *sessionHTTPDAO) AcceptedSessionOperations(ctx context.Context, id string) ([]string, error) {
	d.called(ctx, "AcceptedSessionOperations")
	d.id(id)
	d.f.mu.Lock()
	defer d.f.mu.Unlock()
	ids := []string{}
	if len(d.f.acceptedPlans) > 0 && d.queryRevision == d.f.queryRevision {
		ids = append(ids, d.f.acceptedPlans[0]...)
		d.f.acceptedPlans = d.f.acceptedPlans[1:]
	}
	return ids, ctx.Err()
}
func (d *sessionHTTPDAO) UnreconciledSessionOperations(ctx context.Context, id string, epoch int64) ([]string, error) {
	d.called(ctx, "UnreconciledSessionOperations")
	d.id(id)
	return []string{}, ctx.Err()
}
func (d *sessionHTTPDAO) UnreconciledSessionOperationCount(ctx context.Context, id string, epoch int64) (int, error) {
	d.called(ctx, "UnreconciledSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}

func (f *sessionHTTPFixture) supplyState(state sp.State) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record.Snapshot.Identity.NativeSessionID = state.NativeSessionID
	f.record.Snapshot.InitialInputState = state.InitialInputState
}
func (f *sessionHTTPFixture) supplySource(seq int64) {
	f.mu.Lock()
	f.record.SourceSeq = seq
	f.mu.Unlock()
}
func (f *sessionHTTPFixture) suppliedOperation(t *testing.T, c sp.Command, receipt sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.writes.operations) == 0 {
		t.Fatal("operation insert was not called")
	}
	captured := f.writes.operations[len(f.writes.operations)-1]
	if captured.OperationID != c.OperationID || captured.Command.Fence != c.Fence || captured.Command.Kind != c.Kind || receipt.OperationID != c.OperationID || receipt.State != "accepted" {
		t.Fatal("operation insert or HTTP receipt changed submitted command")
	}
	if !reflect.DeepEqual(captured.Receipt, receipt) {
		t.Fatal("inserted receipt differs from HTTP receipt")
	}
	// Intent, receipt state and sequence are declared independently; only the generated hash is selected.
	record := store.SessionOperation{SessionID: c.SessionID, OperationID: c.OperationID, Command: c, Receipt: receipt, Actor: f.handler.principal, Hash: bytes.Clone(captured.Hash), Seq: int64(len(f.operations) + 1), Deadline: time.Now().Add(time.Minute)}
	if captured.Seq != record.Seq {
		t.Fatalf("operation sequence=%d, want%d", captured.Seq, record.Seq)
	}
	f.operations = append(f.operations, record)
	f.queryRevision++
	f.record.OperationSeq = record.Seq
}
func (f *sessionHTTPFixture) supplyReceipt(t *testing.T, operation sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	found := false
	for i := range f.operations {
		if f.operations[i].OperationID == operation.OperationID {
			f.operations[i].Receipt = operation
			found = true
		}
	}
	if !found {
		t.Fatal("receipt has no independently configured operation")
	}
}

var _ store.SessionDAO = (*sessionHTTPDAO)(nil)

func (f *sessionHTTPFixture) suppliedOffer(t *testing.T, id, epoch string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	parsed, err := strconv.ParseInt(epoch, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	foundEpoch, foundReceipt := false, false
	for _, in := range f.writes.epochs {
		if in.id == id && in.epoch == parsed {
			foundEpoch = true
		}
	}
	for _, in := range f.writes.receipts {
		if in.OperationID == id && in.State == "offered" {
			foundReceipt = true
		}
	}
	if !foundEpoch || !foundReceipt {
		t.Fatal("offer did not write exact epoch and offered receipt")
	}
	for i := range f.operations {
		if f.operations[i].OperationID == id {
			f.operations[i].Epoch = &parsed
			f.operations[i].Receipt.State = "offered"
			return
		}
	}
	t.Fatal("offer has no independently configured intent")
}

func (f *sessionHTTPFixture) expectCommand(t *testing.T, c sp.Command) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.intentIDs {
		if id == c.OperationID {
			t.Fatal("duplicate command test identity")
		}
	}
	f.intentIDs = append(f.intentIDs, c.OperationID)
}

func (f *sessionHTTPFixture) selectOffers(t *testing.T, ids ...string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range ids {
		found := false
		for _, o := range f.operations {
			if o.OperationID == id {
				found = true
			}
		}
		if !found {
			t.Fatal("offer query selected an unconfigured command")
		}
	}
	f.acceptedPlans = append(f.acceptedPlans, append([]string(nil), ids...))
	f.queryRevision++
}
