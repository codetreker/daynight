package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type previewDAO struct{ store.PreviewSSODAO }

type previewWriter struct {
	t             *testing.T
	ctx           context.Context
	dao           *previewDAO
	callbackError error
	completion    store.Completion
	err           error
	calls         int
	before        error
}

func (w *previewWriter) WritePreviewSSO(ctx context.Context, operation func(store.PreviewSSODAO) error) (store.Completion, error) {
	w.calls++
	if ctx != w.ctx || w.calls != 1 {
		w.t.Fatal("unexpected transaction context or extra invocation")
	}
	if w.before != nil {
		return w.completion, w.before
	}
	if got := operation(w.dao); got != w.callbackError {
		w.t.Fatalf("callback error=%v want %v", got, w.callbackError)
	}
	return w.completion, w.err
}

func TestPreviewSSOConstructionAndTransactionStartFailure(t *testing.T) {
	if _, err := NewPreviewSSO(nil, "invalid", "https://preview.example", "https://example/auth/callback"); err == nil {
		t.Fatal("accepted invalid origin")
	}
	ctx := t.Context()
	failure := errors.New("transaction start failed")
	w := &previewWriter{t: t, ctx: ctx, before: failure}
	op := &previewOps{t: t}
	s := &PreviewSSO{writer: w, ops: op, now: time.Now}
	result, err := s.Redeem(ctx, "code", "state", "binding")
	if !errors.Is(err, failure) || result != (core.PreviewSSORedemption{}) || w.calls != 1 || op.calls != 0 {
		t.Fatalf("result=%#v err=%v writer=%d operation=%d", result, err, w.calls, op.calls)
	}
}

type previewOps struct {
	t       *testing.T
	ctx     context.Context
	dao     *previewDAO
	now     time.Time
	want    string
	failure error
	calls   int
}

func (o *previewOps) hit(name string, ctx context.Context, dao store.PreviewSSODAO, now time.Time, got, want any) {
	o.calls++
	if name != o.want || o.calls != 1 || ctx != o.ctx || dao != o.dao || now != o.now || !reflect.DeepEqual(got, want) {
		o.t.Fatalf("unexpected operation %s, context, DAO, clock or input: %#v", name, got)
	}
}
func (o *previewOps) Create(ctx context.Context, dao store.PreviewSSODAO, target string, now time.Time) (model.PreviewSSOLogin, error) {
	o.hit("create", ctx, dao, now, target, "target")
	return model.PreviewSSOLogin{ID: "id"}, o.failure
}
func (o *previewOps) Start(ctx context.Context, dao store.PreviewSSODAO, id string, now time.Time) (core.PreviewSSOStart, error) {
	o.hit("start", ctx, dao, now, id, "id")
	return core.PreviewSSOStart{LoginID: "id", State: "state"}, o.failure
}
func (o *previewOps) Authorize(ctx context.Context, dao store.PreviewSSODAO, id, state string, p model.Principal, now time.Time) (core.PreviewSSOAuthorization, error) {
	o.hit("authorize", ctx, dao, now, []any{id, state, p}, []any{"id", "state", model.Principal{UserID: "user", CredentialID: "session", Kind: model.SessionCredential}})
	return core.PreviewSSOAuthorization{Code: "code"}, o.failure
}
func (o *previewOps) Redeem(ctx context.Context, dao store.PreviewSSODAO, code, state, binding string, now time.Time) (core.PreviewSSORedemption, error) {
	o.hit("redeem", ctx, dao, now, []string{code, state, binding}, []string{"code", "state", "binding"})
	return core.PreviewSSORedemption{LoginID: "id", Secret: "secret"}, o.failure
}
func (o *previewOps) Complete(ctx context.Context, dao store.PreviewSSODAO, id, secret string, now time.Time) (string, error) {
	o.hit("complete", ctx, dao, now, []string{id, secret}, []string{"id", "secret"})
	return "target", o.failure
}
func (o *previewOps) Authenticate(ctx context.Context, dao store.PreviewSSODAO, secret string, now time.Time) (model.Principal, time.Time, error) {
	o.hit("authenticate", ctx, dao, now, secret, "secret")
	return model.Principal{UserID: "user", CredentialID: "session", Kind: model.SessionCredential}, o.now, o.failure
}

func TestPreviewSSOTransactions(t *testing.T) {
	for _, name := range []string{"create", "start", "authorize", "redeem", "complete", "authenticate"} {
		for _, stage := range []string{"committed", "refused", "context", "unknown", "completion"} {
			t.Run(name+"/"+stage, func(t *testing.T) {
				ctx := t.Context()
				now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
				dao := &previewDAO{}
				fault := &model.Fault{Code: "invalid_input", Cause: errors.New("refusal")}
				failure := errors.New("commit or cleanup failed")
				w := &previewWriter{t: t, ctx: ctx, dao: dao, completion: store.Completion{Outcome: store.TransactionCommitted}}
				op := &previewOps{t: t, ctx: ctx, dao: dao, now: now, want: name}
				s := &PreviewSSO{writer: w, ops: op, now: func() time.Time { return now.In(time.FixedZone("other", 3600)) }}
				switch stage {
				case "refused":
					op.failure = fault
					w.callbackError = fault
					w.err = fault
				case "context":
					op.failure = context.Canceled
					w.callbackError = context.Canceled
					w.err = context.Canceled
				case "unknown":
					w.completion.Outcome = store.TransactionUnknown
				case "completion":
					w.err = failure
				}
				var got, zero, want any
				var err error
				switch name {
				case "create":
					got, err = s.Create(ctx, "target")
					zero = model.PreviewSSOLogin{}
					want = model.PreviewSSOLogin{ID: "id"}
				case "start":
					got, err = s.Start(ctx, "id")
					zero = core.PreviewSSOStart{}
					want = core.PreviewSSOStart{LoginID: "id", State: "state"}
				case "authorize":
					got, err = s.Authorize(ctx, "id", "state", model.Principal{UserID: "user", CredentialID: "session", Kind: model.SessionCredential})
					zero = core.PreviewSSOAuthorization{}
					want = core.PreviewSSOAuthorization{Code: "code"}
				case "redeem":
					got, err = s.Redeem(ctx, "code", "state", "binding")
					zero = core.PreviewSSORedemption{}
					want = core.PreviewSSORedemption{LoginID: "id", Secret: "secret"}
				case "complete":
					got, err = s.Complete(ctx, "id", "secret")
					zero = ""
					want = "target"
				case "authenticate":
					var p model.Principal
					var expiry time.Time
					p, expiry, err = s.Authenticate(ctx, "secret")
					got = []any{p, expiry}
					zero = []any{model.Principal{}, time.Time{}}
					want = []any{model.Principal{UserID: "user", CredentialID: "session", Kind: model.SessionCredential}, now}
				}
				if w.calls != 1 || op.calls != 1 {
					t.Fatal("transaction or operation not invoked exactly once")
				}
				if stage == "committed" {
					if err != nil || !reflect.DeepEqual(got, want) {
						t.Fatalf("committed result: got %#v %v; want %#v", got, err, want)
					}
				} else {
					if err == nil || !reflect.DeepEqual(got, zero) {
						t.Fatalf("failed operation returned result: %#v %v", got, err)
					}
					switch stage {
					case "refused":
						if !errors.Is(err, fault) {
							t.Fatal(err)
						}
					case "context":
						if !errors.Is(err, context.Canceled) {
							t.Fatal(err)
						}
					case "completion":
						if !errors.Is(err, failure) {
							t.Fatal(err)
						}
					}
				}
			})
		}
	}
}

type previewLiveDAO struct {
	store.PreviewSSODAO
	cleanup      func(context.Context, time.Time) error
	insert       func(context.Context, model.PreviewSSOLogin) error
	start        func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	lock         func(context.Context, string, []byte, model.Principal, time.Time) (time.Time, error)
	authorize    func(context.Context, string, model.Principal, []byte, time.Time) error
	redeem       func(context.Context, []byte, []byte, []byte, time.Time) (model.PreviewSSOLogin, model.Session, error)
	complete     func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	authenticate func(context.Context, []byte, time.Time) (model.Principal, time.Time, error)
}

func (d *previewLiveDAO) CleanupPreviewSSO(ctx context.Context, now time.Time) error {
	return d.cleanup(ctx, now)
}
func (d *previewLiveDAO) InsertPreviewSSO(ctx context.Context, l model.PreviewSSOLogin) error {
	return d.insert(ctx, l)
}
func (d *previewLiveDAO) StartPreviewSSO(ctx context.Context, id string, h []byte, now time.Time) (model.PreviewSSOLogin, error) {
	return d.start(ctx, id, h, now)
}
func (d *previewLiveDAO) LockPreviewAuthorization(ctx context.Context, id string, state []byte, p model.Principal, now time.Time) (time.Time, error) {
	return d.lock(ctx, id, state, p, now)
}
func (d *previewLiveDAO) SetPreviewAuthorization(ctx context.Context, id string, p model.Principal, code []byte, expiry time.Time) error {
	return d.authorize(ctx, id, p, code, expiry)
}
func (d *previewLiveDAO) RedeemPreviewSSO(ctx context.Context, code, state, token []byte, now time.Time) (model.PreviewSSOLogin, model.Session, error) {
	return d.redeem(ctx, code, state, token, now)
}
func (d *previewLiveDAO) CompletePreviewSSO(ctx context.Context, id string, token []byte, now time.Time) (model.PreviewSSOLogin, error) {
	return d.complete(ctx, id, token, now)
}
func (d *previewLiveDAO) AuthenticatePreview(ctx context.Context, token []byte, now time.Time) (model.Principal, time.Time, error) {
	return d.authenticate(ctx, token, now)
}

type previewLiveWriter struct {
	dao   store.PreviewSSODAO
	calls int
}

func (w *previewLiveWriter) WritePreviewSSO(ctx context.Context, op func(store.PreviewSSODAO) error) (store.Completion, error) {
	w.calls++
	if err := op(w.dao); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestPreviewSSOProductionAssembly(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	target := "https://daynight.example/projects?x=%2F"
	principal := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	expires := now.Add(time.Hour)
	dao := &previewLiveDAO{}
	writer := &previewLiveWriter{dao: dao}
	s, err := NewPreviewSSO(writer, "https://daynight.example", "https://preview.daynight.example", "https://daynight.example/auth/callback")
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return now }
	calls := []string{}
	hit := func(name string, c context.Context, n time.Time) {
		if c != ctx || n != now {
			t.Fatal("wrong context or time")
		}
		calls = append(calls, name)
	}
	var inserted model.PreviewSSOLogin
	dao.cleanup = func(c context.Context, n time.Time) error { hit("cleanup", c, n); return nil }
	dao.insert = func(c context.Context, l model.PreviewSSOLogin) error {
		if c != ctx {
			t.Fatal("wrong context")
		}
		calls = append(calls, "insert")
		inserted = l
		return nil
	}
	beforeCreate := time.Now()
	login, err := s.Create(ctx, target)
	createElapsed := time.Since(beforeCreate)
	if err != nil || login.ID == "" || login.ReturnURL != target || login.ExpiresAt.Before(now.Add(core.LoginLifetime)) || login.ExpiresAt.After(now.Add(core.LoginLifetime+createElapsed)) || !reflect.DeepEqual(login, inserted) {
		t.Fatalf("create %#v %v", login, err)
	}
	var stateHash, codeHash, tokenHash []byte
	dao.start = func(c context.Context, id string, h []byte, n time.Time) (model.PreviewSSOLogin, error) {
		hit("start", c, n)
		if id != login.ID {
			t.Fatal("wrong ID")
		}
		stateHash = h
		return login, nil
	}
	start, err := s.Start(ctx, login.ID)
	if err != nil || start.LoginID != login.ID || start.State == "" || !reflect.DeepEqual(stateHash, secret.Hash(start.State)) || start.ExpiresAt != login.ExpiresAt {
		t.Fatalf("start %#v %v", start, err)
	}
	issued := now.Add(5 * time.Second)
	beforeAuthorize := time.Now()
	dao.lock = func(c context.Context, id string, state []byte, p model.Principal, n time.Time) (time.Time, error) {
		if c != ctx || n.Before(now) || n.After(now.Add(time.Since(beforeAuthorize))) || id != login.ID || !reflect.DeepEqual(state, stateHash) || p != principal {
			t.Fatal("wrong authorization lock")
		}
		calls = append(calls, "lock")
		return issued, nil
	}
	dao.authorize = func(c context.Context, id string, p model.Principal, code []byte, expiry time.Time) error {
		if c != ctx || id != login.ID || p != principal || expiry != issued.Add(time.Minute) {
			t.Fatal("wrong authorization")
		}
		calls = append(calls, "authorize")
		codeHash = code
		return nil
	}
	auth, err := s.Authorize(ctx, login.ID, start.State, principal)
	if err != nil || auth.Code == "" || !reflect.DeepEqual(secret.Hash(auth.Code), codeHash) || auth.ExpiresAt != issued.Add(time.Minute) {
		t.Fatalf("authorize %#v %v", auth, err)
	}
	dao.redeem = func(c context.Context, code, state, token []byte, n time.Time) (model.PreviewSSOLogin, model.Session, error) {
		hit("redeem", c, n)
		if !reflect.DeepEqual(code, codeHash) || !reflect.DeepEqual(state, stateHash) {
			t.Fatal("wrong redemption")
		}
		tokenHash = token
		return login, model.Session{ID: principal.CredentialID, UserID: principal.UserID, ExpiresAt: expires}, nil
	}
	redeemed, err := s.Redeem(ctx, auth.Code, start.State, start.State)
	if err != nil || redeemed.LoginID != login.ID || redeemed.Secret == "" || !reflect.DeepEqual(secret.Hash(redeemed.Secret), tokenHash) || redeemed.ExpiresAt != expires {
		t.Fatalf("redeem %#v %v", redeemed, err)
	}
	dao.complete = func(c context.Context, id string, token []byte, n time.Time) (model.PreviewSSOLogin, error) {
		hit("complete", c, n)
		if id != login.ID || !reflect.DeepEqual(token, tokenHash) {
			t.Fatal("wrong completion")
		}
		return login, nil
	}
	gotTarget, err := s.Complete(ctx, login.ID, redeemed.Secret)
	if err != nil || gotTarget != target {
		t.Fatalf("complete %q %v", gotTarget, err)
	}
	dao.authenticate = func(c context.Context, token []byte, n time.Time) (model.Principal, time.Time, error) {
		hit("authenticate", c, n)
		if !reflect.DeepEqual(token, tokenHash) {
			t.Fatal("wrong credential")
		}
		return principal, expires, nil
	}
	gotPrincipal, gotExpiry, err := s.Authenticate(ctx, redeemed.Secret)
	if err != nil || gotPrincipal != principal || gotExpiry != expires || writer.calls != 6 || !reflect.DeepEqual(calls, []string{"cleanup", "insert", "start", "cleanup", "lock", "authorize", "redeem", "complete", "authenticate"}) {
		t.Fatalf("authenticate %#v %v %v calls %v", gotPrincipal, gotExpiry, err, calls)
	}
}
