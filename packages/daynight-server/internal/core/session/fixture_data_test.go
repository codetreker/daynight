package session

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type fixtureConnection struct {
	SessionID, Instance string
	Seen                time.Time
	Expiry              *time.Time
}

type fixtureWrites struct {
	Session      *store.SessionRecord
	Registration *store.SessionRegistration
	Grant        *store.SessionGrant
	Connection   *fixtureConnection
	Touched      *time.Time
	Disconnected bool
	Operation    *store.SessionOperation
	Receipt      *sp.Operation
	Epoch        *int64
	StopProof    []byte
	ArchiveState *sp.ArchiveStatus
	ArchiveReady *fixtureArchiveReady
}

func fixtureCopy[T any](value T) T {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func configureFixtureData(t *testing.T, f fixture) {
	d, data, writes := f.dao, f.data, f.writes
	checkSession := func(id string) {
		t.Helper()
		if data.Session == nil || data.Session.Snapshot.SessionID != id {
			t.Fatalf("Session DAO id = %q, want configured record", id)
		}
	}
	d.LockTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, error) {
		if err := ctx.Err(); err != nil {
			return store.SessionTask{}, err
		}
		if project != f.project || id != f.task || data.TaskDeleted {
			return store.SessionTask{}, model.ErrNotFound
		}
		return fixtureCopy(data.Task), nil
	}
	d.LockArchiveTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
		if project != f.project || id != f.task {
			return store.SessionTask{}, false, model.ErrNotFound
		}
		return fixtureCopy(data.Task), data.TaskDeleted, nil
	}
	d.LockCredentialFn = func(ctx context.Context, p model.Principal, now time.Time) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if p != f.p || now.IsZero() {
			return model.ErrNotFound
		}
		return nil
	}
	d.ReadCredentialFn = d.LockCredentialFn
	d.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user != f.p.UserID || project != f.project {
			return model.ProjectAccess{}, model.ErrNotFound
		}
		return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, nil
	}
	d.LockTaskRegistrationFn = func(ctx context.Context, project, id string) error {
		if project != f.project || id != f.task {
			t.Fatalf("registration lock args %q/%q", project, id)
		}
		return nil
	}
	d.LockTestOwnerFn = func(ctx context.Context, user string) error {
		if user != f.p.UserID {
			t.Fatalf("test owner lock %q", user)
		}
		return nil
	}
	d.FindTaskRegistrationFn = func(ctx context.Context, project, registration, task, claim string) (string, error) {
		if project != f.project || task != f.task || claim != f.r.ClaimID || registration != f.r.RegistrationID {
			t.Fatal("registration lookup changed its key")
		}
		return data.RegistrationID, data.RegistrationError
	}
	d.FindTestRegistrationFn = func(ctx context.Context, owner, registration, execution string) (string, *string, error) {
		if owner != f.p.UserID {
			t.Fatal("test registration lookup changed owner")
		}
		return data.RegistrationID, data.RegistrationBotID, data.RegistrationError
	}
	insert := func(ctx context.Context, in store.SessionRegistration) error {
		if writes.Registration != nil {
			t.Fatal("registration DAO received extra insert")
		}
		writes.Registration = new(fixtureCopy(in))
		return nil
	}
	d.InsertTaskSessionFn = insert
	d.InsertTestSessionFn = insert
	d.SessionBotIDFn = func(ctx context.Context, id string) (*string, error) {
		if data.Session == nil {
			return nil, model.ErrNotFound
		}
		checkSession(id)
		return data.Session.BotID, nil
	}
	d.LockSessionFn = func(ctx context.Context, id string) (store.SessionRecord, error) {
		if data.Session == nil {
			return store.SessionRecord{}, model.ErrNotFound
		}
		checkSession(id)
		return fixtureCopy(*data.Session), nil
	}
	d.SaveSessionFn = func(ctx context.Context, in store.SessionRecord) error {
		checkSession(in.Snapshot.SessionID)
		writes.Session = new(fixtureCopy(in))
		return nil
	}
	d.SessionLocationFn = func(ctx context.Context, id string) (store.SessionLocation, error) {
		checkSession(id)
		return data.Location, data.LocationError
	}
	d.SessionLocationByGrantFn = func(ctx context.Context, hash []byte) (store.SessionLocation, error) {
		if !bytes.Equal(hash, data.GrantHash) {
			return store.SessionLocation{}, model.ErrNotFound
		}
		return data.Location, data.LocationError
	}
	d.SetSessionGrantFn = func(ctx context.Context, in store.SessionGrant) error {
		checkSession(in.SessionID)
		writes.Grant = new(fixtureCopy(in))
		return nil
	}
	d.ConnectSessionFn = func(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
		checkSession(id)
		writes.Connection = &fixtureConnection{SessionID: id, Instance: instance, Seen: seen, Expiry: expiry}
		return nil
	}
	d.TouchSessionFn = func(ctx context.Context, id string, seen time.Time) error {
		checkSession(id)
		writes.Touched = &seen
		return nil
	}
	d.DisconnectSessionFn = func(ctx context.Context, id string) error {
		checkSession(id)
		writes.Disconnected = true
		return nil
	}
	d.CurrentTaskSessionFn = func(ctx context.Context, project, task, claim string) (string, error) {
		if project != f.project || task != f.task || claim != f.r.ClaimID {
			t.Fatal("current Session lookup changed its key")
		}
		return data.CurrentSessionID, data.CurrentSessionError
	}
	d.SessionOperationFn = func(ctx context.Context, session, id string) (store.SessionOperation, error) {
		checkSession(session)
		if data.Operation == nil {
			return store.SessionOperation{}, model.ErrNotFound
		}
		if data.Operation.OperationID != id {
			return store.SessionOperation{}, model.ErrNotFound
		}
		return fixtureCopy(*data.Operation), nil
	}
	d.InsertSessionOperationFn = func(ctx context.Context, in store.SessionOperation) error {
		checkSession(in.SessionID)
		writes.Operation = new(fixtureCopy(in))
		return nil
	}
	d.SetSessionOperationReceiptFn = func(ctx context.Context, in sp.Operation) error {
		writes.Receipt = new(fixtureCopy(in))
		return nil
	}
	d.SetSessionOperationEpochFn = func(ctx context.Context, session, id string, epoch int64) error {
		checkSession(session)
		if data.Operation == nil || data.Operation.OperationID != id {
			t.Fatal("dispatch epoch targeted unconfigured operation")
		}
		writes.Epoch = &epoch
		return nil
	}
	d.PendingSessionOperationCountFn = func(ctx context.Context, id string) (int, error) { checkSession(id); return data.PendingCount, nil }
	d.AcceptedSessionOperationsFn = func(ctx context.Context, id string) ([]string, error) {
		checkSession(id)
		return append([]string(nil), data.AcceptedIDs...), nil
	}
	d.StoppingTestOperationsFn = func(ctx context.Context, id string) ([]string, error) {
		checkSession(id)
		return append([]string(nil), data.StoppingIDs...), nil
	}
	d.UnreconciledSessionOperationsFn = func(ctx context.Context, id string, epoch int64) ([]string, error) {
		checkSession(id)
		return append([]string(nil), data.UnreconciledIDs...), nil
	}
	d.UnreconciledSessionOperationCountFn = func(ctx context.Context, id string, epoch int64) (int, error) {
		checkSession(id)
		return data.UnreconciledCount, nil
	}
	d.HasOtherFirstInputFn = func(ctx context.Context, session, id string) (bool, error) {
		checkSession(session)
		return data.OtherFirstInput, nil
	}
	d.HasInteractionResponseFn = func(ctx context.Context, session, id, interaction string) (bool, error) {
		checkSession(session)
		return data.InteractionResponse, nil
	}
	d.SetSessionGenerationStopFn = func(ctx context.Context, id string, proof []byte) error {
		checkSession(id)
		writes.StopProof = bytes.Clone(proof)
		return nil
	}
	d.SetTestSessionStopFn = d.SetSessionGenerationStopFn
}

func (f fixture) SelectRegistrationWrite(t *testing.T) {
	t.Helper()
	in := f.writes.Registration
	if in == nil || in.OwnerID != f.p.UserID || in.Location.SessionID != in.Snapshot.SessionID {
		t.Fatal("registration capture does not establish configured identity")
	}
	f.data.Session = &store.SessionRecord{Snapshot: fixtureCopy(in.Snapshot), Owner: in.OwnerID, Parent: in.ParentCredentialID, Registration: bytes.Clone(in.Registration), BotID: in.BotID}
	f.data.RegistrationID = in.Location.SessionID
	f.data.RegistrationError = nil
	f.data.RegistrationBotID = in.BotID
	f.data.Location = in.Location
	f.data.LocationError = nil
	f.data.CurrentSessionID = in.Location.SessionID
	f.data.CurrentSessionError = nil
	f.writes.Registration = nil
}

func (f fixture) SelectSessionWrite(t *testing.T) {
	t.Helper()
	in := f.writes.Session
	if in == nil || f.data.Session == nil || in.Snapshot.SessionID != f.data.Session.Snapshot.SessionID {
		t.Fatal("saved Session capture does not match the next response")
	}
	f.data.Session.Snapshot = fixtureCopy(in.Snapshot)
	f.data.Session.SourceEpoch = in.SourceEpoch
	f.data.Session.SourceEpochs = append([]string(nil), in.SourceEpochs...)
	f.data.Session.SourceSeq = in.SourceSeq
	f.data.Session.OperationSeq = in.OperationSeq
	f.writes.Session = nil
}

func (f fixture) SelectGrantWrite(t *testing.T) {
	t.Helper()
	in := f.writes.Grant
	if in == nil || f.data.Session == nil || in.SessionID != f.data.Session.Snapshot.SessionID || in.ParentCredentialID != f.p.CredentialID {
		t.Fatal("grant capture does not match configured authority")
	}
	f.data.Session.GrantHash = bytes.Clone(in.Hash)
	f.data.Session.GrantExpiry = &in.ExpiresAt
	f.data.Session.GrantKind = in.Kind
	f.data.Session.Parent = in.ParentCredentialID
	f.data.GrantHash = bytes.Clone(in.Hash)
	f.writes.Grant = nil
}

func (f fixture) SelectConnectionWrite(t *testing.T) {
	t.Helper()
	in := f.writes.Connection
	if in == nil || f.data.Session == nil || in.SessionID != f.data.Session.Snapshot.SessionID || in.Instance != f.s.instance {
		t.Fatal("connection capture changed configured relay identity")
	}
	f.data.Session.ServerInstance = &in.Instance
	f.data.Session.LastSeen = &in.Seen
	f.data.Session.ConnectionExpiry = in.Expiry
	f.data.Session.ConnectionParent = f.data.Session.Parent
	f.data.Session.Consumed = true
	f.writes.Connection = nil
	f.SelectSessionWrite(t)
}

func (f fixture) SelectOperationWrite(t *testing.T) {
	t.Helper()
	in := f.writes.Operation
	if in == nil || f.data.Session == nil || in.SessionID != f.data.Session.Snapshot.SessionID || in.OperationID != in.Command.OperationID || in.Receipt.OperationID != in.OperationID {
		t.Fatal("operation capture lost submitted identity")
	}
	f.data.Operation = new(fixtureCopy(*in))
	f.data.Operation.Deadline = f.data.OperationDeadline
	f.writes.Operation = nil
}

func (f fixture) SelectReceiptWrite(t *testing.T) {
	t.Helper()
	if f.writes.Receipt == nil || f.data.Operation == nil || f.writes.Receipt.OperationID != f.data.Operation.OperationID {
		t.Fatal("receipt capture changed configured operation")
	}
	f.data.Operation.Receipt = fixtureCopy(*f.writes.Receipt)
	f.writes.Receipt = nil
}

func (f fixture) SelectEpochWrite(t *testing.T) {
	t.Helper()
	if f.writes.Epoch == nil || f.data.Operation == nil {
		t.Fatal("dispatch epoch capture missing")
	}
	f.data.Operation.Epoch = f.writes.Epoch
	f.writes.Epoch = nil
}

func (f fixture) SelectTouchWrite(t *testing.T) {
	t.Helper()
	if f.writes.Touched == nil || f.data.Session == nil {
		t.Fatal("heartbeat capture missing")
	}
	f.data.Session.LastSeen = f.writes.Touched
	f.writes.Touched = nil
}

func (f fixture) SelectDisconnectWrite(t *testing.T) {
	t.Helper()
	if !f.writes.Disconnected || f.data.Session == nil {
		t.Fatal("disconnect capture missing")
	}
	f.data.Session.ConnectionExpiry = nil
	f.data.Session.LastSeen = nil
	f.writes.Disconnected = false
}
