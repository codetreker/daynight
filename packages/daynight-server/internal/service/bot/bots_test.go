package bot

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBotCreationForwardsNormalizedRequestAndFrozenResult(t *testing.T) {
	for _, resolved := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit", true: "resolved replay"}[resolved], func(t *testing.T) {
			names := []string{"write", "create", "write_done"}
			if resolved {
				names = []string{"snapshot", "get", "read_done", "write", "create", "write_done"}
			}
			f := newBotFixture(t, names...)
			in := botInput(uuid.NewString())
			in.ID = strings.ToUpper(in.ID)
			in.Name = "  助手  "
			upper := strings.ToUpper(in.ResolvedConfiguration.WorkerID)
			in.Overrides.WorkerID = &upper
			normalized, fp, e := botcore.NormalizeBotRequest(in)
			if e != nil {
				t.Fatal(e)
			}
			want := frozenBot(f.p, normalized)
			f.service.operations.get = func(ctx context.Context, s store.SnapshotScope, p model.Principal, id string) (model.Bot, error) {
				f.plan.call("get")
				identical(t, ctx, f.ctx)
				identical(t, s, f.snapshot)
				same(t, p, f.p)
				same(t, id, normalized.ID)
				return want, nil
			}
			f.service.operations.create = func(ctx context.Context, d store.BotWriteDAO, p model.Principal, v botcore.CreateBot, fingerprint string, r bool) (model.Bot, error) {
				f.plan.call("create")
				identical(t, ctx, f.ctx)
				identical(t, d, f.write.dao)
				same(t, p, f.p)
				same(t, v, normalized)
				same(t, fingerprint, fp)
				same(t, r, resolved)
				return want, nil
			}
			var got model.Bot
			var err error
			if resolved {
				got, err = f.service.CreateResolved(f.ctx, f.p, in)
			} else {
				got, err = f.service.Create(f.ctx, f.p, in)
			}
			if err != nil {
				t.Fatal(err)
			}
			same(t, got, want)
		})
	}
}
func TestBotWriteCompletionControlsVisibleResults(t *testing.T) {
	refusal := &model.Fault{Code: "forbidden", Message: "lower refusal"}
	cleanup := errors.New("cleanup failed")
	commit := errors.New("commit outcome unknown")
	for _, tc := range []struct {
		name          string
		outcome       store.TransactionOutcome
		lower, finish error
		fault         bool
	}{
		{"committed", store.TransactionCommitted, nil, nil, false}, {"missing outcome", "", nil, nil, false}, {"unknown without error", store.TransactionUnknown, nil, nil, false}, {"not committed without error", store.TransactionNotCommitted, nil, nil, false},
		{"commit failure", store.TransactionUnknown, nil, &store.TransactionError{Phase: "commit", Cause: commit, Outcome: store.TransactionUnknown, CommitAttempted: true}, false},
		{"confirmed refusal", store.TransactionNotCommitted, refusal, nil, true},
		{"refusal with cleanup failure", store.TransactionUnknown, refusal, &store.TransactionError{Phase: "operation", Cause: errors.Join(refusal, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true}, false},
		{"refusal with unknown outcome", store.TransactionUnknown, refusal, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotFixture(t, "write", "create", "write_done")
			in := botInput(uuid.NewString())
			want := frozenBot(f.p, in)
			f.completion = tc.outcome
			f.writeCallbackError = tc.lower
			f.writeFinishError = tc.finish
			f.service.operations.create = func(ctx context.Context, d store.BotWriteDAO, p model.Principal, v botcore.CreateBot, fp string, r bool) (model.Bot, error) {
				f.plan.call("create")
				identical(t, ctx, f.ctx)
				identical(t, d, f.write.dao)
				same(t, p, f.p)
				same(t, v, in)
				same(t, r, false)
				return want, tc.lower
			}
			got, err := f.service.Create(f.ctx, f.p, in)
			if tc.outcome == store.TransactionCommitted && tc.finish == nil && tc.lower == nil {
				if err != nil {
					t.Fatal(err)
				}
				same(t, got, want)
				return
			}
			same(t, got, model.Bot{})
			if tc.fault {
				same(t, err, refusal)
			} else {
				var op *model.BotOperationError
				if !errors.As(err, &op) || op.Operation != "create" {
					t.Fatalf("operational failure lost: %v", err)
				}
			}
			for _, cause := range []error{tc.lower, tc.finish} {
				if cause != nil && !errors.Is(err, cause) {
					t.Fatalf("lost cause %v: %v", cause, err)
				}
			}
		})
	}
}
func TestBotReadsForwardScopeAndSuppressResultsOnFailure(t *testing.T) {
	for _, op := range []string{"get", "list", "worker"} {
		for _, phase := range []string{"success", "lower", "completion", "snapshot"} {
			t.Run(op+"/"+phase, func(t *testing.T) {
				names := []string{"snapshot", op, "read_done"}
				if phase == "snapshot" {
					names = []string{"snapshot"}
				}
				f := newBotFixture(t, names...)
				id := uuid.NewString()
				in := botInput(id)
				want := frozenBot(f.p, in)
				cause := errors.New("read failed")
				if phase == "lower" {
					f.readCallbackError = cause
				}
				if phase == "completion" {
					f.readFinishError = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				}
				if phase == "snapshot" {
					f.readBeginError = cause
				}
				f.service.operations.get = func(ctx context.Context, s store.SnapshotScope, p model.Principal, key string) (model.Bot, error) {
					f.plan.call("get")
					identical(t, ctx, f.ctx)
					identical(t, s, f.snapshot)
					same(t, p, f.p)
					same(t, key, in.ID)
					return want, f.readCallbackError
				}
				f.service.operations.list = func(ctx context.Context, s store.SnapshotScope, p model.Principal, w *string, page store.Page) (store.BotPage, error) {
					f.plan.call(op)
					identical(t, ctx, f.ctx)
					identical(t, s, f.snapshot)
					same(t, p, f.p)
					same(t, page, store.Page{Limit: 2})
					if op == "worker" {
						same(t, w, &id)
					} else {
						same(t, w, (*string)(nil))
					}
					return store.BotPage{Items: []model.Bot{want}, HasMore: true}, f.readCallbackError
				}
				var got any
				var err error
				if op == "get" {
					got, err = f.service.Get(f.ctx, f.p, strings.ToUpper(in.ID))
				} else if op == "list" {
					got, err = f.service.List(f.ctx, f.p, model.PageRequest{Limit: 2})
				} else {
					got, err = f.service.ListWorker(f.ctx, f.p, strings.ToUpper(id), model.PageRequest{Limit: 2})
				}
				if phase == "success" {
					if err != nil {
						t.Fatal(err)
					}
					if op == "get" {
						same(t, got, want)
					} else {
						page := got.(botcore.BotPage)
						same(t, page.Items, []model.Bot{want})
						if page.NextCursor == nil {
							t.Fatal("missing cursor")
						}
						_, e := botcore.ListPage(testPrincipal(), nil, model.PageRequest{Limit: 2, Cursor: page.NextCursor})
						requireFault(t, e, "invalid_input")
					}
					return
				}
				if err == nil {
					t.Fatal("failure became success")
				}
				if op == "get" {
					same(t, got, model.Bot{})
				} else {
					same(t, got, botcore.BotPage{})
				}
				expected := cause
				if phase == "completion" {
					expected = f.readFinishError
				}
				if !errors.Is(err, expected) {
					t.Fatalf("lost cause: %v", err)
				}
			})
		}
	}
}
func TestBotAdmissionRejectsBeforeOpeningScope(t *testing.T) {
	f := newBotFixture(t)
	in := botInput(uuid.NewString())
	for _, fn := range []func() error{
		func() error { _, e := f.service.Create(f.ctx, model.Principal{}, in); return e }, func() error { _, e := f.service.Get(f.ctx, model.Principal{}, in.ID); return e }, func() error { _, e := f.service.List(f.ctx, model.Principal{}, model.PageRequest{Limit: 10}); return e }, func() error { _, e := f.service.Defaults(f.ctx, model.Principal{}, nil); return e },
	} {
		requireFault(t, fn(), "unauthenticated")
	}
	for _, fn := range []func() error{
		func() error { _, e := f.service.Get(f.ctx, f.p, "bad"); return e }, func() error { _, e := f.service.ListWorker(f.ctx, f.p, "bad", model.PageRequest{Limit: 10}); return e }, func() error { _, e := f.service.List(f.ctx, f.p, model.PageRequest{Limit: 0}); return e }, func() error {
			_, e := f.service.List(f.ctx, f.p, model.PageRequest{Limit: 10, Cursor: pointer("broken")})
			return e
		}, func() error { _, e := f.service.Defaults(f.ctx, f.p, pointer("bad")); return e },
	} {
		requireFault(t, fn(), "invalid_input")
	}
	for _, o := range []model.BotOverrides{{Model: pointer(" ")}, {ReasoningEffort: pointer("\n")}} {
		_, e := f.service.DefaultsFor(f.ctx, f.p, o)
		requireFault(t, e, "invalid_input")
	}
	for _, change := range []func(*botcore.CreateBot){func(v *botcore.CreateBot) { v.ID = "bad" }, func(v *botcore.CreateBot) { v.Name = "   " }, func(v *botcore.CreateBot) { v.Name = strings.Repeat("界", 41) }, func(v *botcore.CreateBot) { v.Name = "\tName" }, func(v *botcore.CreateBot) { v.Name = string([]byte{0xff}) }, func(v *botcore.CreateBot) { v.Overrides.WorkerID = pointer("invalid") }, func(v *botcore.CreateBot) { v.Overrides.Cwd = pointer("relative") }, func(v *botcore.CreateBot) { v.Overrides.Provider = pointer("unsupported") }} {
		v := in
		change(&v)
		_, e := f.service.Create(f.ctx, f.p, v)
		requireFault(t, e, "invalid_input")
	}
}
func TestBotOperationErrorsPreserveUncertainAndJoinedFailures(t *testing.T) {
	refusal := &model.Fault{Code: "forbidden", Message: "lower refusal"}
	for _, tx := range []*store.TransactionError{{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true}, {Phase: "cleanup", Cause: refusal, Outcome: store.TransactionUnknown, CleanupFailed: true}, {Phase: "operation", Cause: errors.Join(refusal, errors.New("another failure")), Outcome: store.TransactionNotCommitted}} {
		e := botcore.ResultError("create", tx)
		var op *model.BotOperationError
		if !errors.As(e, &op) || !errors.Is(e, tx) || reflect.DeepEqual(e, refusal) {
			t.Fatalf("lost operational failure: %v", e)
		}
	}
}

type oauthBotWriteDAO struct {
	store.BotWriteDAO
	t         *testing.T
	plan      *callPlan
	principal model.Principal
	bot       model.Bot
	reads     int
}

func (d *oauthBotWriteDAO) Credential(_ context.Context, p model.Principal) error {
	d.plan.call("credential")
	same(d.t, p, d.principal)
	return nil
}
func (d *oauthBotWriteDAO) LockCreation(_ context.Context, id string) error {
	d.plan.call("lock")
	same(d.t, id, d.bot.ID)
	return nil
}
func (d *oauthBotWriteDAO) Bot(_ context.Context, id string) (model.Bot, error) {
	d.plan.call("read")
	same(d.t, id, d.bot.ID)
	d.reads++
	if d.reads == 1 {
		return model.Bot{}, model.ErrNotFound
	}
	return d.bot, nil
}
func (d *oauthBotWriteDAO) Worker(_ context.Context, user, worker string) error {
	d.plan.call("worker")
	same(d.t, user, d.principal.UserID)
	same(d.t, worker, d.bot.WorkerID)
	return nil
}
func (d *oauthBotWriteDAO) InsertBot(_ context.Context, bot model.Bot) error {
	d.plan.call("insert")
	same(d.t, bot, model.Bot{ID: d.bot.ID, OwnerUserID: d.principal.UserID, WorkerID: d.bot.WorkerID, Name: d.bot.Name, RequestFingerprint: d.bot.RequestFingerprint, ResolvedConfiguration: d.bot.ResolvedConfiguration})
	return nil
}

type oauthBotReader struct {
	store.BotReader
	t    *testing.T
	plan *callPlan
	bot  model.Bot
}

func (d oauthBotReader) Bot(_ context.Context, id string) (model.Bot, error) {
	d.plan.call("bot")
	same(d.t, id, d.bot.ID)
	return d.bot, nil
}

type oauthBotCredential struct {
	t         *testing.T
	plan      *callPlan
	principal model.Principal
	err       error
}

func (d oauthBotCredential) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.plan.call("credential")
	same(d.t, p, d.principal)
	return store.ThreadCredential{}, d.err
}

type oauthBotStore struct {
	plan     *callPlan
	write    store.BotWriteDAO
	snapshot *snapshotToken
}

func (s oauthBotStore) WriteBot(_ context.Context, fn func(store.BotScope) error) (store.Completion, error) {
	s.plan.call("write")
	err := fn(&writeToken{dao: s.write})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s oauthBotStore) ReadSnapshot(_ context.Context, fn func(store.SnapshotScope) error) error {
	s.plan.call("snapshot")
	return fn(s.snapshot)
}

func TestOAuthBotCreationAndReadCredentials(t *testing.T) {
	p := model.Principal{Kind: model.OAuthCredential, UserID: "c1111111-1111-4111-8111-111111111111", CredentialID: "f6666666-6666-4666-8666-666666666666"}
	bot := model.Bot{ID: "a4444444-4444-4444-8444-444444444444", OwnerUserID: p.UserID, WorkerID: "b5555555-5555-4555-8555-555555555555", Name: "OAuth Bot", Version: 1, CreatedAt: time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC), ResolvedConfiguration: model.BotConfiguration{WorkerID: "b5555555-5555-4555-8555-555555555555", Cwd: "/workspace", Provider: "codex", Args: []string{}}}
	input := botcore.CreateBot{ID: bot.ID, Name: bot.Name, ResolvedConfiguration: bot.ResolvedConfiguration}
	_, fingerprint, err := botcore.NormalizeBotRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	bot.RequestFingerprint = fingerprint
	t.Run("create", func(t *testing.T) {
		plan := newPlan(t, "write", "credential", "lock", "read", "worker", "insert", "read", "credential")
		dao := &oauthBotWriteDAO{t: t, plan: plan, principal: p, bot: bot}
		got, err := New(oauthBotStore{plan: plan, write: dao}).Create(t.Context(), p, input)
		if err != nil {
			t.Fatal(err)
		}
		same(t, got, bot)
	})
	for _, tc := range []struct {
		name      string
		principal model.Principal
		err       error
	}{
		{"valid", p, nil},
		{"forged", model.Principal{Kind: model.OAuthCredential, UserID: p.UserID, CredentialID: "f3333333-3333-4333-8333-333333333333"}, model.ErrNotFound},
		{"revoked", p, model.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{"snapshot", "credential"}
			if tc.err == nil {
				calls = append(calls, "bot")
			}
			plan := newPlan(t, calls...)
			snapshot := &snapshotToken{credential: oauthBotCredential{t: t, plan: plan, principal: tc.principal, err: tc.err}, reader: oauthBotReader{t: t, plan: plan, bot: bot}}
			got, err := New(oauthBotStore{plan: plan, snapshot: snapshot}).Get(t.Context(), tc.principal, bot.ID)
			if tc.err != nil {
				if err == nil {
					t.Fatal("refused OAuth credential accepted")
				}
				same(t, got, model.Bot{})
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			same(t, got, bot)
		})
	}
}
