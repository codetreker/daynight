package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

type definitionSource struct {
	read, write, deletion func(model.Principal) model.CredentialAuthorization
	readScope             store.SnapshotScope
	writeScope            store.BotScope
	deleteScope           store.SessionScope
}

func (s *definitionSource) Read(_ context.Context, scope store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
	s.readScope = scope
	return s.read(p), nil
}
func (s *definitionSource) BotWrite(_ context.Context, scope store.BotScope, p model.Principal) (model.CredentialAuthorization, error) {
	s.writeScope = scope
	return s.write(p), nil
}
func (s *definitionSource) SessionWrite(_ context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
	s.deleteScope = scope
	return s.deletion(p), nil
}

func scopedAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) func(model.Principal) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return func(p model.Principal) model.CredentialAuthorization {
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
	}
}

type definitionStore struct {
	store.BotWriter
	snapshot store.SnapshotScope
	write    store.BotScope
	writes   int
}

func (s *definitionStore) ReadSnapshot(_ context.Context, fn func(store.SnapshotScope) error) error {
	if err := fn(s.snapshot); err != nil {
		return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return nil
}
func (s *definitionStore) WriteBot(_ context.Context, fn func(store.BotScope) error) (store.Completion, error) {
	s.writes++
	if err := fn(s.write); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestScopedCreationChecksBeforeDiscoveryAndRechecksWrite(t *testing.T) {
	p := testPrincipal()
	input := botInput(uuid.NewString())
	for _, tc := range []struct {
		name        string
		read, write []scopepolicy.ScopeID
		wantWrites  int
	}{
		{"no write", []scopepolicy.ScopeID{"bot:read", "session:read"}, nil, 0},
		{"no read", []scopepolicy.ScopeID{"bot:write", "session:read"}, nil, 0},
		{"no session", []scopepolicy.ScopeID{"bot:read", "bot:write"}, nil, 0},
		{"revoked before transaction", []scopepolicy.ScopeID{"bot:read", "bot:write", "session:read"}, []scopepolicy.ScopeID{"bot:read", "session:read"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := &snapshotToken{}
			write := &writeToken{dao: &botToken{}}
			db := &definitionStore{snapshot: snapshot, write: write}
			source := &definitionSource{read: scopedAuthorization(t, tc.read...)}
			if tc.write != nil {
				source.write = scopedAuthorization(t, tc.write...)
			}
			s, err := NewScoped(db, source)
			if err != nil {
				t.Fatal(err)
			}
			s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
				return model.Bot{}, &model.Fault{Code: "not_found", Message: "Bot not found"}
			}
			s.operations.createScoped = func(_ context.Context, _ store.BotWriteDAO, _ model.Principal, _ botcore.CreateBot, _ string, _ bool, admit func() error) (model.Bot, error) {
				return model.Bot{}, admit()
			}
			// The resolved path would issue discovery reads if the preflight allowed it.
			if tc.wantWrites == 0 {
				_, err = s.CreateResolved(t.Context(), p, input)
			} else {
				_, err = s.Create(t.Context(), p, input)
			}
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
				t.Fatalf("scope refusal: %v", err)
			}
			if db.writes != tc.wantWrites || source.readScope != snapshot {
				t.Fatalf("preflight/write: %d %#v", db.writes, source.readScope)
			}
			if tc.wantWrites == 1 && source.writeScope != write {
				t.Fatal("write admission lost transaction scope")
			}
		})
	}
}

type scopedDeletionWriter struct {
	scope   deletionScope
	outcome store.TransactionOutcome
}

func (w scopedDeletionWriter) WriteSession(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	err := fn(w.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return store.Completion{Outcome: w.outcome}, nil
}

func TestScopedDeleteRejectsAfterOwnerBeforeBarrier(t *testing.T) {
	for _, scopes := range [][]scopepolicy.ScopeID{{"bot:read"}, {"bot:delete"}} {
		var calls []string
		p := testPrincipal()
		id := uuid.NewString()
		request := store.DeleteBot{Version: 1, DeletionID: uuid.NewString()}
		dao := &deletionDAO{calls: &calls}
		bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, Version: 1}}
		scope := deletionScope{dao: dao, bot: bots}
		authorize := scopedAuthorization(t, scopes...)
		source := &definitionSource{deletion: func(p model.Principal) model.CredentialAuthorization {
			calls = append(calls, "policy")
			return authorize(p)
		}}
		live := &discardedSessions{}
		s, err := NewScopedDeletions(scopedDeletionWriter{scope: scope}, nil, live, source)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.DeleteBot(t.Context(), p, id, request)
		if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
			t.Fatalf("scope refusal: %v", err)
		}
		if !reflect.DeepEqual(calls, []string{"policy", "credential", "bot"}) || len(live.ids) != 0 || source.deleteScope != scope {
			t.Fatalf("unauthorized deletion had effects: calls=%v live=%v", calls, live.ids)
		}
	}
}

func TestScopedGetChecksOwnerBeforeScopeAndSuppressesDeniedResult(t *testing.T) {
	p := testPrincipal()
	id := uuid.NewString()
	snapshot := &snapshotToken{}
	db := &definitionStore{snapshot: snapshot}
	source := &definitionSource{read: scopedAuthorization(t, "bot:read")}
	s, err := NewScoped(db, source)
	if err != nil {
		t.Fatal(err)
	}
	forbidden := &model.Fault{Code: "forbidden", Message: "not owner"}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{}, forbidden
	}
	_, err = s.Get(t.Context(), p, id)
	if !errors.Is(err, forbidden) || source.readScope != nil {
		t.Fatalf("owner refusal: %v", err)
	}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{ID: id, OwnerUserID: p.UserID}, nil
	}
	got, err := s.Get(t.Context(), p, id)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || !reflect.DeepEqual(got, model.Bot{}) || source.readScope != snapshot {
		t.Fatalf("session projection refusal: bot=%+v err=%v", got, err)
	}
}

func TestScopedAttentionProjectionRequiresAssistantTaskRead(t *testing.T) {
	p := testPrincipal()
	id := uuid.NewString()
	snapshot := &snapshotToken{}
	db := &definitionStore{snapshot: snapshot, write: &writeToken{dao: &botToken{}}}
	base := scopedAuthorization(t, "bot:read", "bot:write", "session:read")
	withAttention := scopedAuthorization(t, "assistant-task:read", "bot:read", "bot:write", "session:read")
	source := &definitionSource{read: base, write: base}
	s, err := NewScoped(db, source)
	if err != nil {
		t.Fatal(err)
	}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{ID: id, OwnerUserID: p.UserID, AttentionCount: 2}, nil
	}
	if _, err := s.Get(t.Context(), p, id); err != nil {
		t.Fatalf("ordinary view: %v", err)
	}
	ctx := botcore.WithAttentionProjection(t.Context())
	if got, err := s.Get(ctx, p, id); !errors.Is(err, scopepolicy.ErrInsufficientScope) || !reflect.DeepEqual(got, model.Bot{}) {
		t.Fatalf("attention read: %+v %v", got, err)
	}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{}, &model.Fault{Code: "not_found", Message: "missing"}
	}
	s.operations.createScoped = func(_ context.Context, _ store.BotWriteDAO, _ model.Principal, _ botcore.CreateBot, _ string, _ bool, admit func() error) (model.Bot, error) {
		return model.Bot{}, admit()
	}
	input := botInput(uuid.NewString())
	if _, err := s.Create(ctx, p, input); !errors.Is(err, scopepolicy.ErrInsufficientScope) || db.writes != 0 {
		t.Fatalf("attention preflight: %v writes=%d", err, db.writes)
	}
	source.read = withAttention
	if _, err := s.Create(ctx, p, input); !errors.Is(err, scopepolicy.ErrInsufficientScope) || db.writes != 1 {
		t.Fatalf("attention transaction recheck: %v writes=%d", err, db.writes)
	}
}

func TestScopedCreationPreservesExistingOwnerRefusal(t *testing.T) {
	p := testPrincipal()
	db := &definitionStore{snapshot: &snapshotToken{}}
	source := &definitionSource{read: scopedAuthorization(t, "bot:read")}
	s, err := NewScoped(db, source)
	if err != nil {
		t.Fatal(err)
	}
	forbidden := &model.Fault{Code: "forbidden", Message: "not owner"}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{}, forbidden
	}
	_, err = s.CreateResolved(t.Context(), p, botInput(uuid.NewString()))
	if !errors.Is(err, forbidden) || source.readScope != nil || db.writes != 0 {
		t.Fatalf("existing owner refusal: %v", err)
	}
}

type definitionCredential struct{ store.CredentialReader }

func (definitionCredential) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, nil
}

type definitionReader struct {
	store.BotReader
	workerError error
	queried     bool
}

func (r *definitionReader) BotWorker(context.Context, string, string) error { return r.workerError }
func (r *definitionReader) Bots(context.Context, string, *string, store.Page) (store.BotPage, error) {
	r.queried = true
	return store.BotPage{}, nil
}
func TestScopedWorkerListChecksVisibilityBeforeScopeAndQuery(t *testing.T) {
	for _, denied := range []bool{false, true} {
		p := testPrincipal()
		reader := &definitionReader{}
		if denied {
			reader.workerError = model.ErrNotFound
		}
		snapshot := &snapshotToken{reader: reader, credential: definitionCredential{}}
		db := &definitionStore{snapshot: snapshot}
		source := &definitionSource{read: scopedAuthorization(t, "bot:write")}
		s, err := NewScoped(db, source)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.ListWorker(t.Context(), p, uuid.NewString(), model.PageRequest{Limit: 10})
		if denied {
			if errors.Is(err, scopepolicy.ErrInsufficientScope) || source.readScope != nil || reader.queried {
				t.Fatalf("hidden Worker: %v", err)
			}
		} else if !errors.Is(err, scopepolicy.ErrInsufficientScope) || source.readScope != snapshot || reader.queried {
			t.Fatalf("query before admission: %v", err)
		}
	}
}

func TestScopedDefaultsChecksWorkerVisibilityBeforeScope(t *testing.T) {
	for _, denied := range []bool{false, true} {
		p := testPrincipal()
		reader := &definitionReader{}
		if denied {
			reader.workerError = model.ErrNotFound
		}
		snapshot := &snapshotToken{reader: reader, credential: definitionCredential{}}
		db := &definitionStore{snapshot: snapshot}
		source := &definitionSource{read: scopedAuthorization(t, "bot:write")}
		s, err := NewScoped(db, source)
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.DefaultsFor(t.Context(), p, model.BotOverrides{WorkerID: pointer(uuid.NewString())})
		if denied {
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "forbidden" || source.readScope != nil {
				t.Fatalf("hidden Worker: %v", err)
			}
		} else if !errors.Is(err, scopepolicy.ErrInsufficientScope) || source.readScope != snapshot {
			t.Fatalf("defaults authorization: %v", err)
		}
	}
}

func TestScopedDeletePreservesOwnerRefusal(t *testing.T) {
	var calls []string
	p := testPrincipal()
	id := uuid.NewString()
	dao := &deletionDAO{calls: &calls}
	bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: uuid.NewString(), Version: 1}}
	scope := deletionScope{dao: dao, bot: bots}
	authorize := scopedAuthorization(t, "bot:read")
	source := &definitionSource{deletion: func(p model.Principal) model.CredentialAuthorization {
		calls = append(calls, "policy")
		return authorize(p)
	}}
	s, err := NewScopedDeletions(scopedDeletionWriter{scope: scope}, nil, &discardedSessions{}, source)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DeleteBot(t.Context(), p, id, store.DeleteBot{Version: 1, DeletionID: uuid.NewString()})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "forbidden" || !reflect.DeepEqual(calls, []string{"policy", "credential", "bot"}) {
		t.Fatalf("owner denial must precede scope decision: %v, %v", err, calls)
	}
}

func TestScopedObservationRechecksAfterLiveSample(t *testing.T) {
	f := newObservationTestFixture(t)
	full := scopedAuthorization(t, "bot:read", "session:read")
	revoked := scopedAuthorization(t, "bot:read")
	count := 0
	f.service.authorization = &definitionSource{read: func(p model.Principal) model.CredentialAuthorization {
		count++
		if count == 1 {
			return full(p)
		}
		return revoked(p)
	}}
	f.wantEvents = append(observationReadEvents(0), "live", "begin1", "get1", "end1")
	got, err := f.service.Observation(f.ctx, f.principal, f.id)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || !reflect.DeepEqual(got, botcore.Observation{}) || count != 2 {
		t.Fatalf("revocation must suppress live result: observation=%+v err=%v checks=%d", got, err, count)
	}
}

func TestDefinitionResultRetainsUnknownAndCleanupFailures(t *testing.T) {
	fault := &model.Fault{Code: "insufficient_scope", Message: "scope"}
	if definitionResultError("read", fault) != fault {
		t.Fatal("direct refusal lost")
	}
	for _, tx := range []*store.TransactionError{
		{Phase: "operation", Outcome: store.TransactionUnknown, Cause: fault},
		{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault},
	} {
		err := definitionResultError("read", tx)
		var op *model.BotOperationError
		if !errors.As(err, &op) || !errors.Is(err, tx) {
			t.Fatalf("unsafe failure lost: %v", err)
		}
	}
}

func TestScopedDefaultsRequiresInspectOnlyForDiscovery(t *testing.T) {
	for _, discover := range []bool{false, true} {
		p := testPrincipal()
		worker := uuid.NewString()
		base := nativeBase(worker)
		if !discover {
			base.Model = nil
			base.Selection.ModelSource = "native"
		}
		defaults := model.BotDefaultsInput{WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Native: map[string]model.BotNativePreference{base.Provider: {}}}}}
		snapshot := &snapshotToken{credential: definitionCredential{}, reader: &defaultsReader{read: func(context.Context, string) (model.BotDefaultsInput, error) { return defaults, nil }}}
		db := &definitionStore{snapshot: snapshot}
		count := 0
		authorize := scopedAuthorization(t, "bot:read", "worker:read")
		source := &definitionSource{read: func(p model.Principal) model.CredentialAuthorization { count++; return authorize(p) }}
		s, err := NewScoped(db, source)
		if err != nil {
			t.Fatal(err)
		}
		s.operations.defaults = func(model.BotDefaultsInput, model.BotOverrides) (botcore.BotDefaults, error) {
			return botcore.BotDefaults{Configuration: &base}, nil
		}
		s.operations.workerDefaults = func(model.BotDefaultsInput, model.BotOverrides, string) (model.BotConfiguration, error) {
			return base, nil
		}
		s.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
			t.Fatal("unauthorized discovery")
			return ro.Message{}, nil
		})
		_, err = s.DefaultsFor(t.Context(), p, model.BotOverrides{})
		if discover {
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || count != 2 {
				t.Fatalf("discovery check: %v, %d", err, count)
			}
		} else if err != nil || count != 1 {
			t.Fatalf("ordinary defaults: %v, %d", err, count)
		}
	}
}

func mcpAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) func(model.Principal) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.MCP, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return func(p model.Principal) model.CredentialAuthorization {
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedMCPProfile, Policy: &policy}
	}
}

func fullMCPAuthorization(t *testing.T) func(model.Principal) model.CredentialAuthorization {
	t.Helper()
	entries, err := scopepolicy.Catalog(scopepolicy.MCP)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]scopepolicy.ScopeID, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.ID)
	}
	return mcpAuthorization(t, ids...)
}

func TestScopedCreationMCPAllowsImplicitDiscovery(t *testing.T) {
	for _, discover := range []bool{false, true} {
		p := testPrincipal()
		p.Kind = model.OAuthCredential
		worker := uuid.NewString()
		base := nativeBase(worker)
		if !discover {
			base.Model = nil
			base.Selection.ModelSource = "native"
		}
		defaults := model.BotDefaultsInput{WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Native: map[string]model.BotNativePreference{base.Provider: {}}}}}
		snapshot := &snapshotToken{reader: &readToken{}}
		db := &definitionStore{snapshot: snapshot}
		count := 0
		authorize := fullMCPAuthorization(t)
		source := &definitionSource{read: func(p model.Principal) model.CredentialAuthorization { count++; return authorize(p) }}
		s, err := NewScoped(db, source)
		if err != nil {
			t.Fatal(err)
		}
		s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
			return model.Bot{}, &model.Fault{Code: "not_found", Message: "missing"}
		}
		s.operations.creationDefaults = func(context.Context, store.BotCreationReader, string, model.BotOverrides) (model.BotDefaultsInput, botcore.BotDefaults, error) {
			return defaults, botcore.BotDefaults{Configuration: &base}, nil
		}
		s.operations.workerDefaults = func(model.BotDefaultsInput, model.BotOverrides, string) (model.BotConfiguration, error) {
			return base, nil
		}
		s.models = modelRequestFunc(func(_ context.Context, principal model.Principal, workerID string, request ro.Request) (ro.Message, error) {
			return nativeResponse(principal, workerID, request), nil
		})
		resolution, err := s.prepareCreation(t.Context(), p, botInput(worker))
		if discover {
			if err != nil || resolution == nil || count != 1 {
				t.Fatalf("discovery check: %v, %d", err, count)
			}
		} else if err != nil || count != 0 {
			t.Fatalf("ordinary creation: %v, %d", err, count)
		}
	}
}

func TestScopedCreationDoesNotWriteAfterDiscoveryRefusal(t *testing.T) {
	p := testPrincipal()
	p.Kind = model.OAuthCredential
	worker := uuid.NewString()
	input := botInput(worker)
	base := nativeBase(worker)
	defaults := model.BotDefaultsInput{WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Native: map[string]model.BotNativePreference{base.Provider: {}}}}}
	plan := newPlan(t, "credential", "lock", "read")
	dao := &oauthBotWriteDAO{t: t, plan: plan, principal: p, bot: model.Bot{ID: input.ID}}
	snapshot := &snapshotToken{reader: &readToken{}}
	db := &definitionStore{snapshot: snapshot, write: &writeToken{dao: dao}}
	authorize := fullMCPAuthorization(t)
	revoked := mcpAuthorization(t, "bot:read", "session:read")
	readCount := 0
	source := &definitionSource{read: func(p model.Principal) model.CredentialAuthorization {
		readCount++
		if readCount == 1 {
			return authorize(p)
		}
		return revoked(p)
	}, write: authorize}
	s, err := NewScoped(db, source)
	if err != nil {
		t.Fatal(err)
	}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{}, &model.Fault{Code: "not_found", Message: "missing"}
	}
	s.operations.creationDefaults = func(context.Context, store.BotCreationReader, string, model.BotOverrides) (model.BotDefaultsInput, botcore.BotDefaults, error) {
		return defaults, botcore.BotDefaults{Configuration: &base}, nil
	}
	s.operations.workerDefaults = func(model.BotDefaultsInput, model.BotOverrides, string) (model.BotConfiguration, error) {
		return base, nil
	}
	s.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
		t.Fatal("unauthorized discovery")
		return ro.Message{}, nil
	})
	_, err = s.CreateResolved(t.Context(), p, input)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("discovery refusal: %v", err)
	}
}
