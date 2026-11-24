package usage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

type producerDAO struct {
	store.UsageDAO
	session       store.UsageSession
	state         model.UsageRecord
	now           time.Time
	reads, writes int
	validParents  map[string]bool
	lockedParents []string
}

func (d *producerDAO) Session(context.Context, string) (store.UsageSession, error) {
	return d.session, nil
}
func (d *producerDAO) State(context.Context, string) (model.UsageRecord, error) { return d.state, nil }
func (d *producerDAO) ParentValid(_ context.Context, id, user string, lock bool) (bool, error) {
	if d.validParents != nil {
		if lock {
			d.lockedParents = append(d.lockedParents, id)
		}
		return d.validParents[id] && user == d.state.AuthorityUserID, nil
	}
	return id == *d.state.ParentCredentialID && user == d.state.AuthorityUserID, nil
}
func (d *producerDAO) Now(context.Context) (time.Time, error) { return d.now, nil }
func (d *producerDAO) Generation(context.Context, string, string) (model.UsageRecord, error) {
	d.reads++
	if d.state.RowVersion != "" {
		return d.state, nil
	}
	return model.UsageRecord{}, model.ErrNotFound
}
func (d *producerDAO) Anchor(context.Context, string, string, string) (model.UsageRecord, error) {
	return model.UsageRecord{}, model.ErrNotFound
}
func (d *producerDAO) Insert(_ context.Context, r model.UsageRecord) error {
	d.writes++
	d.state = r
	return nil
}
func (d *producerDAO) Replace(_ context.Context, r model.UsageRecord, _ string) error {
	d.writes++
	d.state = r
	return nil
}
func (d *producerDAO) Source(context.Context, model.UsageRecord, string) (model.UsageRecord, error) {
	d.reads++
	return model.UsageRecord{}, model.ErrNotFound
}
func (d *producerDAO) Guard(context.Context, model.UsageRecord) error { d.writes++; return nil }
func (d *producerDAO) Executions(context.Context, store.UsageFilter) ([]store.UsageExecution, error) {
	d.reads++
	return nil, nil
}

type producerSessionDAO struct {
	store.SessionDAO
	snapshot sp.Snapshot
}

func (d producerSessionDAO) LockSession(context.Context, string) (store.SessionRecord, error) {
	return store.SessionRecord{Snapshot: d.snapshot}, nil
}
func (d producerSessionDAO) ReadCredential(context.Context, model.Principal, time.Time) error {
	return nil
}
func (d producerSessionDAO) LockCredential(context.Context, model.Principal, time.Time) error {
	return nil
}

type producerScope struct {
	dao     *producerDAO
	session producerSessionDAO
}

func (s *producerScope) UsageDAO() store.UsageDAO     { return s.dao }
func (s *producerScope) SessionDAO() store.SessionDAO { return s.session }

func TestProducerAdmissionUsesOriginalCredentialAndPreventsNewResources(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	stateID := "10000000-0000-4000-8000-000000000002"
	instance := "10000000-0000-4000-8000-000000000003"
	registration := "10000000-0000-4000-8000-000000000004"
	execution := "10000000-0000-4000-8000-000000000005"
	native := "native"
	allowed := usageAuth(t, "session:produce")
	denied := usageAuth(t, "usage:read")
	p := allowed.Principal
	now := time.Now().UTC()
	dao := &producerDAO{now: now, session: store.UsageSession{ID: id, Scope: "test", Backend: "web", OwnerID: p.UserID, ParentID: p.CredentialID, ConnectionParentID: p.CredentialID, TestExecutionID: &execution, CreatedAt: now}, state: model.UsageRecord{ParentCredentialID: &p.CredentialID, AuthorityUserID: p.UserID}}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{Provider: "copilot", ControllerInstanceID: instance, NativeSessionID: &native}, Lifecycle: "active"}
	scope := &producerScope{dao: dao, session: producerSessionDAO{snapshot: snapshot}}
	db := controlledStore{write: func(ctx context.Context, f func(store.UsageScope) error) (store.Completion, error) {
		err := f(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}, read: func(ctx context.Context, f func(store.UsageScope) error) error { return f(scope) }}
	current, checks, expectWrite := denied, 0, true
	s, err := NewScoped(db, Options{WriteEnabled: true}, func(_ context.Context, gotScope store.UsageScope, got model.Principal, at time.Time, write bool) (model.CredentialAuthorization, error) {
		checks++
		if gotScope != scope || got != p || !at.Equal(now) || write != expectWrite {
			t.Fatalf("wrong producer context: %#v %v %v", got, at, write)
		}
		return current, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	input := Registration{Protocol: core.Protocol, StateID: stateID, SessionID: id, Generation: "1", ControllerInstanceID: instance, ConnectionEpoch: "1", NativeSessionID: native, ProfileID: "copilot-event-1.0.11-v1", ProviderVersion: "1.0.11", RegistrationID: registration}
	assertDenied := func(err error) {
		t.Helper()
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != "insufficient_scope" {
			t.Fatalf("scope denial: %v", err)
		}
	}
	_, err = s.Register(t.Context(), p, input)
	assertDenied(err)
	if checks != 1 || dao.reads != 0 || dao.writes != 0 {
		t.Fatal("registration accessed protected state or wrote after refusal")
	}
	current = allowed
	registered, err := s.Register(t.Context(), p, input)
	if err != nil || registered.Grant == nil || !registered.Created || dao.writes != 1 {
		t.Fatalf("register: %#v %v", registered, err)
	}
	current = denied
	before := dao.writes
	reads := dao.reads
	_, err = s.Register(t.Context(), p, input)
	assertDenied(err)
	if dao.writes != before || dao.reads != reads || dao.state.ID != registered.State.ID || dao.state.BodyHash != registered.State.BodyHash {
		t.Fatal("denied replay changed or returned the committed registration")
	}
	current = allowed
	replay, err := s.Register(t.Context(), p, input)
	if err != nil || replay.Created || replay.Grant != nil || replay.State.ID != registered.State.ID || replay.State.BodyHash != registered.State.BodyHash || dao.writes != before {
		t.Fatalf("committed registration replay: %#v %v", replay, err)
	}
	current = denied
	_, err = s.Rotate(t.Context(), p, stateID, GrantRequest{ExpectedRowVersion: "1", SessionID: id, Generation: "1", ControllerInstanceID: instance, ConnectionEpoch: "1"})
	assertDenied(err)
	if dao.writes != before {
		t.Fatal("rotated grant after refusal")
	}
	// An existing usage grant remains bound to its own parent across a Session
	// reconnect, even when the Session now records another producer.
	dao.session.ParentID = "other"
	dao.session.ConnectionParentID = "other"
	batch := Batch{Protocol: core.Protocol, BatchID: registration, Events: []model.UsageEvent{{EventID: instance, Kind: "execution_state"}}}
	_, err = s.Batch(t.Context(), stateID, registered.Grant.Token, batch)
	assertDenied(err)
	if dao.writes != before {
		t.Fatal("batch modified a record after refusal")
	}
	expectWrite = false
	reads = dao.reads
	_, err = s.Sources(t.Context(), stateID, registered.Grant.Token, []string{"source"})
	assertDenied(err)
	if dao.reads != reads {
		t.Fatal("delivered source after refusal")
	}
	current = allowed
	out, err := s.Sources(t.Context(), stateID, registered.Grant.Token, []string{"source"})
	if err != nil || len(out.MissingKeys) != 1 || dao.reads != reads+1 {
		t.Fatalf("authorized sources: %#v %v", out, err)
	}
	checksBefore := checks
	_, err = s.Sources(t.Context(), stateID, "bad", []string{"source"})
	code(t, err, "invalid_grant")
	if checks != checksBefore {
		t.Fatal("checked policy for invalid grant")
	}
}

func TestProducerStateAndRevokeCheckScopeBeforeDeliveryAndMutation(t *testing.T) {
	allowed := usageAuth(t, "session:produce")
	denied := usageAuth(t, "usage:read")
	p := allowed.Principal
	now := time.Now().UTC()
	dao := &producerDAO{now: now, session: store.UsageSession{ID: "session", Scope: "test", OwnerID: p.UserID}, state: model.UsageRecord{SessionID: "session", RowVersion: "1"}}
	scope := &producerScope{dao: dao}
	db := controlledStore{write: func(ctx context.Context, f func(store.UsageScope) error) (store.Completion, error) {
		err := f(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}, read: func(ctx context.Context, f func(store.UsageScope) error) error { return f(scope) }}
	current := denied
	s, err := NewScoped(db, Options{WriteEnabled: true}, func(_ context.Context, actual store.UsageScope, actor model.Principal, at time.Time, _ bool) (model.CredentialAuthorization, error) {
		if actual != scope || actor != p || !at.Equal(now) {
			t.Fatal("producer recheck lost actor or transaction")
		}
		return current, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range []func() error{
		func() error { _, err := s.State(t.Context(), p, "state"); return err },
		func() error { _, err := s.Revoke(t.Context(), p, "state", "1"); return err },
	} {
		var fault *model.Fault
		if err := call(); !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
			t.Fatalf("scope refusal: %v", err)
		}
	}
	if dao.reads != 0 || dao.writes != 0 {
		t.Fatal("protected state was read or changed")
	}
	current = allowed
	if _, err = s.State(t.Context(), p, "state"); err != nil || dao.reads != 1 {
		t.Fatalf("state: %v", err)
	}
	result, err := s.Revoke(t.Context(), p, "state", "1")
	if err != nil || result.GrantRevokedAt == nil || result.RowVersion != "2" || dao.writes != 1 {
		t.Fatalf("revoke: %#v %v", result, err)
	}
}

func TestProducerAuthorizationRejectsMissingOrChangedPolicy(t *testing.T) {
	if _, err := NewScoped(nil, Options{}, nil); err == nil {
		t.Fatal("missing current authorization accepted")
	}
	p := usageAuth(t, "session:produce")
	other := p
	other.Principal.CredentialID = "33333333-3333-4333-8333-333333333333"
	for _, current := range []model.CredentialAuthorization{other, {Principal: p.Principal, Profile: model.ScopedPATProfile}} {
		s, err := NewScoped(nil, Options{}, func(context.Context, store.UsageScope, model.Principal, time.Time, bool) (model.CredentialAuthorization, error) {
			return current, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if err = s.requireProducer(t.Context(), nil, p.Principal, time.Now(), false); err == nil {
			t.Fatal("invalid current authorization accepted")
		}
	}
}

func TestRotationRechecksBothCurrentAndOriginalParents(t *testing.T) {
	sessionID := "10000000-0000-4000-8000-000000000001"
	instance := "10000000-0000-4000-8000-000000000003"
	execution := "10000000-0000-4000-8000-000000000005"
	native := "native"
	original := usageAuth(t, "session:produce")
	replacement := usageAuth(t, "session:produce")
	replacement.Principal.CredentialID = "33333333-3333-4333-8333-333333333333"
	now := time.Now().UTC()
	end := now.Add(time.Hour)
	_, hash, err := mint([32]byte{})
	if err != nil {
		t.Fatal(err)
	}
	dao := &producerDAO{now: now, validParents: map[string]bool{original.Principal.CredentialID: true, replacement.Principal.CredentialID: true}, session: store.UsageSession{ID: sessionID, Scope: "test", OwnerID: replacement.Principal.UserID, ParentID: replacement.Principal.CredentialID, ConnectionParentID: replacement.Principal.CredentialID, TestExecutionID: &execution, CreatedAt: now}, state: model.UsageRecord{ID: "state", SessionID: sessionID, Generation: "1", AuthorityUserID: original.Principal.UserID, ParentCredentialID: &original.Principal.CredentialID, NativeSessionID: native, RowVersion: "1", GrantHash: hash, GrantExpiresAt: &end}}
	scope := &producerScope{dao: dao, session: producerSessionDAO{snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{Provider: "copilot", ControllerInstanceID: instance, NativeSessionID: &native}, Lifecycle: "active"}}}
	db := controlledStore{write: func(ctx context.Context, f func(store.UsageScope) error) (store.Completion, error) {
		err := f(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}}
	policies := map[string]model.CredentialAuthorization{original.Principal.CredentialID: original, replacement.Principal.CredentialID: replacement}
	checks := []string{}
	s, err := NewScoped(db, Options{WriteEnabled: true}, func(_ context.Context, gotScope store.UsageScope, p model.Principal, _ time.Time, write bool) (model.CredentialAuthorization, error) {
		if gotScope != scope || !write {
			t.Fatal("incorrect transaction")
		}
		checks = append(checks, p.CredentialID)
		return policies[p.CredentialID], nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := GrantRequest{ExpectedRowVersion: "1", SessionID: sessionID, Generation: "1", ControllerInstanceID: instance, ConnectionEpoch: "1"}
	deny := usageAuth(t, "usage:read")
	deny.Principal = original.Principal
	policies[original.Principal.CredentialID] = deny
	_, err = s.Rotate(t.Context(), replacement.Principal, "state", request)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || dao.writes != 0 {
		t.Fatalf("original scope: %v", err)
	}
	if len(dao.lockedParents) != 2 || dao.lockedParents[0] != original.Principal.CredentialID || dao.lockedParents[1] != replacement.Principal.CredentialID || len(checks) != 2 {
		t.Fatalf("parents not independently locked and checked: %v %v", dao.lockedParents, checks)
	}
	policies[original.Principal.CredentialID] = original
	dao.lockedParents, checks = nil, nil
	deny.Principal = replacement.Principal
	policies[replacement.Principal.CredentialID] = deny
	_, err = s.Rotate(t.Context(), replacement.Principal, "state", request)
	if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || dao.writes != 0 {
		t.Fatalf("replacement scope: %v", err)
	}
	policies[replacement.Principal.CredentialID] = replacement
	dao.lockedParents, checks = nil, nil
	dao.validParents[original.Principal.CredentialID] = false
	_, err = s.Rotate(t.Context(), replacement.Principal, "state", request)
	code(t, err, "permission_revoked")
	if dao.writes != 0 {
		t.Fatal("rotated with invalid original parent")
	}
	dao.validParents[original.Principal.CredentialID] = true
	dao.lockedParents, checks = nil, nil
	result, err := s.Rotate(t.Context(), replacement.Principal, "state", request)
	if err != nil || result.Grant == nil || *result.State.ParentCredentialID != original.Principal.CredentialID || dao.writes != 1 {
		t.Fatalf("valid rotation: %#v %v", result, err)
	}
	// A same-ID rotation locks and checks the shared parent once.
	dao.session.ParentID = original.Principal.CredentialID
	dao.session.ConnectionParentID = original.Principal.CredentialID
	dao.lockedParents, checks = nil, nil
	request.ExpectedRowVersion = "2"
	if _, err = s.Rotate(t.Context(), original.Principal, "state", request); err != nil {
		t.Fatal(err)
	}
	if len(dao.lockedParents) != 1 || len(checks) != 1 {
		t.Fatalf("shared parent was checked repeatedly: %v %v", dao.lockedParents, checks)
	}
}
