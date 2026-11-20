package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func definitionAuthorization(t *testing.T, kind scopepolicy.CredentialType, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(kind, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{
		Principal: model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"},
		Policy:    &policy,
	}
	if kind == scopepolicy.PAT {
		auth.Principal.Kind, auth.Profile = model.PATCredential, model.ScopedPATProfile
	} else {
		auth.Principal.Kind, auth.Profile = model.OAuthCredential, model.ScopedMCPProfile
	}
	return auth
}

func TestScopedCreationAdmissionPrecedesMutationAndFollowsVisibility(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{UserID: "owner"}
	in, fingerprint, err := NormalizeBotRequest(input())
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.New("scope denied")
	for _, tc := range []struct {
		name       string
		read       creationHistoryRead
		wantCalls  []string
		wantDenied bool
	}{
		{"new", creationHistoryRead{err: model.ErrNotFound}, []string{"credential", "lock", "bot", "admit"}, true},
		{"owned replay", creationHistoryRead{bot: model.Bot{OwnerUserID: principal.UserID}}, []string{"credential", "lock", "bot", "admit"}, true},
		{"other owner", creationHistoryRead{bot: model.Bot{OwnerUserID: "other"}}, []string{"credential", "lock", "bot"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: in.ID, reads: []creationHistoryRead{tc.read}, wantCalls: tc.wantCalls}
			result, err := CreateScoped(ctx, dao, principal, in, fingerprint, true, func() error {
				dao.record(ctx, "admit")
				return denied
			})
			if tc.wantDenied && !errors.Is(err, denied) {
				t.Fatalf("expected scope refusal, got %v", err)
			}
			if !tc.wantDenied {
				assertFault(t, err, "forbidden")
			}
			if !reflect.DeepEqual(result, model.Bot{}) || len(dao.inserts) != 0 {
				t.Fatalf("denial returned or inserted a definition: %+v %+v", result, dao.inserts)
			}
			dao.verify()
		})
	}
	if _, err := CreateScoped(ctx, &botDAO{}, principal, in, fingerprint, false, nil); err == nil {
		t.Fatal("missing creation admission was accepted")
	}
	dao := &botDAO{fail: map[string]error{}}
	calls := 0
	admit := func() error { calls++; return nil }
	created, err := CreateScoped(ctx, dao, principal, in, fingerprint, false, admit)
	if err != nil || dao.current == nil || created.OwnerUserID != principal.UserID || calls != 1 {
		t.Fatalf("allowed creation: %+v calls=%d err=%v", created, calls, err)
	}
	replay, err := CreateScoped(ctx, dao, principal, in, fingerprint, false, admit)
	if err != nil || !reflect.DeepEqual(replay, created) || calls != 2 {
		t.Fatalf("allowed replay: %+v calls=%d err=%v", replay, calls, err)
	}
}

func TestScopedListAdmissionPrecedesPageReadAndFollowsWorkerVisibility(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{UserID: "owner"}
	denied := errors.New("scope denied")
	r := &reader{fail: map[string]error{}}
	page := store.Page{Limit: 2}
	called := 0
	admit := func() error { called++; return denied }
	_, err := ListScoped(ctx, snapshot{r: r, err: model.ErrNotFound}, principal, ptr(workerID), page, admit)
	assertFault(t, err, "unauthenticated")
	r.fail["worker"] = model.ErrNotFound
	_, err = ListScoped(ctx, snapshot{r: r}, principal, ptr(workerID), page, admit)
	assertFault(t, err, "forbidden")
	if called != 0 || r.listCalls != 0 {
		t.Fatal("admitted or queried before credential and Worker visibility")
	}
	delete(r.fail, "worker")
	_, err = ListScoped(ctx, snapshot{r: r}, principal, ptr(workerID), page, admit)
	if !errors.Is(err, denied) || called != 1 || r.listCalls != 0 {
		t.Fatalf("scope refusal: err=%v admission calls=%d page calls=%d", err, called, r.listCalls)
	}
	_, err = ListScoped(ctx, snapshot{r: r}, principal, nil, page, func() error { called++; return nil })
	if err != nil || called != 2 || r.listCalls != 1 {
		t.Fatalf("allowed list: err=%v admission calls=%d page calls=%d", err, called, r.listCalls)
	}
	if _, err := ListScoped(ctx, snapshot{r: r}, principal, nil, page, nil); err == nil {
		t.Fatal("missing list admission was accepted")
	}
}

type scopedCreationWorkerDAO struct {
	*creationHistoryDAO
	workerErrors []error
	workerCalls  int
}

func (d *scopedCreationWorkerDAO) Worker(ctx context.Context, owner, id string) error {
	d.record(ctx, "worker")
	if owner != d.principal.UserID || id != workerID || d.workerCalls >= len(d.workerErrors) {
		d.t.Fatalf("unexpected Worker check: owner=%q id=%q calls=%d", owner, id, d.workerCalls)
	}
	err := d.workerErrors[d.workerCalls]
	d.workerCalls++
	return err
}

func TestScopedCreationChecksExplicitWorkerBeforeAdmissionAndAgainBeforeInsert(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{UserID: "owner"}
	in := input()
	in.Overrides.WorkerID = ptr(workerID)
	in, fingerprint, err := NormalizeBotRequest(in)
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.New("scope denied")
	for _, tc := range []struct {
		name         string
		reads        []creationHistoryRead
		workers      []error
		calls        []string
		admissionErr error
		wantCode     string
		wantDenied   bool
	}{
		{"invisible Worker", []creationHistoryRead{{err: model.ErrNotFound}}, []error{model.ErrNotFound}, []string{"credential", "lock", "bot", "worker"}, denied, "forbidden", false},
		{"visible Worker, denied", []creationHistoryRead{{err: model.ErrNotFound}}, []error{nil}, []string{"credential", "lock", "bot", "worker", "admit"}, denied, "", true},
		{"Worker changes before insert", []creationHistoryRead{{err: model.ErrNotFound}}, []error{nil, model.ErrNotFound}, []string{"credential", "lock", "bot", "worker", "admit", "worker"}, nil, "forbidden", false},
		{"existing Bot replay", []creationHistoryRead{{bot: model.Bot{ID: botID, OwnerUserID: principal.UserID, RequestFingerprint: fingerprint}}}, nil, []string{"credential", "lock", "bot", "admit", "credential"}, nil, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			history := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: in.ID, reads: tc.reads, wantCalls: tc.calls}
			dao := &scopedCreationWorkerDAO{creationHistoryDAO: history, workerErrors: tc.workers}
			result, err := CreateScoped(ctx, dao, principal, in, fingerprint, false, func() error {
				history.record(ctx, "admit")
				return tc.admissionErr
			})
			switch {
			case tc.wantCode != "":
				assertFault(t, err, tc.wantCode)
			case tc.wantDenied:
				if !errors.Is(err, denied) {
					t.Fatalf("expected scope refusal, got %v", err)
				}
			case err != nil || result.ID != botID:
				t.Fatalf("replay: %+v %v", result, err)
			}
			if dao.workerCalls != len(tc.workers) {
				t.Fatalf("Worker checks=%d, want %d", dao.workerCalls, len(tc.workers))
			}
			history.verify()
		})
	}
}

func TestDefinitionScopeAdmission(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		t.Run(string(kind), func(t *testing.T) {
			for _, tc := range []struct {
				name       string
				scopes     []scopepolicy.ScopeID
				operations []scopepolicy.Operation
				allowed    bool
			}{
				{"read", []scopepolicy.ScopeID{"bot:read"}, []scopepolicy.Operation{scopepolicy.BotRead}, true},
				{"read cannot write", []scopepolicy.ScopeID{"bot:read"}, []scopepolicy.Operation{scopepolicy.BotWrite}, false},
				{"write cannot read", []scopepolicy.ScopeID{"bot:write"}, []scopepolicy.Operation{scopepolicy.BotRead}, false},
				{"write", []scopepolicy.ScopeID{"bot:write"}, []scopepolicy.Operation{scopepolicy.BotWrite}, true},
				{"delete", []scopepolicy.ScopeID{"bot:delete"}, []scopepolicy.Operation{scopepolicy.BotDelete}, true},
				{"write full response needs read", []scopepolicy.ScopeID{"bot:write"}, []scopepolicy.Operation{scopepolicy.BotWrite, scopepolicy.BotRead}, false},
				{"delete full response needs read", []scopepolicy.ScopeID{"bot:delete"}, []scopepolicy.Operation{scopepolicy.BotDelete, scopepolicy.BotRead}, false},
				{"write full response", []scopepolicy.ScopeID{"bot:read", "bot:write"}, []scopepolicy.Operation{scopepolicy.BotWrite, scopepolicy.BotRead}, true},
				{"delete full response", []scopepolicy.ScopeID{"bot:delete", "bot:read"}, []scopepolicy.Operation{scopepolicy.BotDelete, scopepolicy.BotRead}, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					auth := definitionAuthorization(t, kind, tc.scopes...)
					err := RequireDefinition(auth, tc.operations...)
					if tc.allowed && err != nil || !tc.allowed && !errors.Is(err, scopepolicy.ErrInsufficientScope) {
						t.Fatalf("allowed %v, got %v", tc.allowed, err)
					}
					if !tc.allowed {
						var fault *model.Fault
						if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
							t.Fatalf("scope refusal must retain its domain classification: %v", err)
						}
					}
				})
			}
		})
	}
}

func TestDefinitionAuthorizationDoesNotAuthorizeSessionOrExecution(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		auth := definitionAuthorization(t, kind, "bot:delete", "bot:read", "bot:write")
		for _, operation := range []scopepolicy.Operation{scopepolicy.SessionRead, scopepolicy.SessionSend, scopepolicy.SessionControl, scopepolicy.SessionProduce, scopepolicy.WorkerClaim} {
			if err := RequireDefinition(auth, operation); err == nil {
				t.Fatalf("%s accepted non-definition operation %s", kind, operation)
			}
			required, err := scopepolicy.Requirements(operation)
			if err != nil {
				t.Fatal(err)
			}
			if err := auth.Policy.Require(required...); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
				t.Fatalf("%s gained %s: %v", kind, operation, err)
			}
		}
	}
}

func TestAttentionProjectionIsExplicitAndFollowsRequestContext(t *testing.T) {
	base := context.Background()
	if AttentionProjectionRequested(base) {
		t.Fatal("attention was requested by default")
	}
	marked := WithAttentionProjection(base)
	child, cancel := context.WithCancel(marked)
	defer cancel()
	if !AttentionProjectionRequested(marked) || !AttentionProjectionRequested(child) || AttentionProjectionRequested(base) {
		t.Fatal("attention marker was not confined to the marked context")
	}
}

type workerVisibilityReader struct {
	store.BotReader
	t         *testing.T
	ctx       context.Context
	owner, id string
	err       error
	calls     int
}

func (r *workerVisibilityReader) BotWorker(ctx context.Context, owner, id string) error {
	r.t.Helper()
	if ctx != r.ctx || owner != r.owner || id != r.id {
		r.t.Fatalf("Worker check: context=%v owner=%q id=%q", ctx, owner, id)
	}
	r.calls++
	return r.err
}

func TestRequireWorkerRetainsOwnershipAndErrors(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{UserID: "owner"}
	r := &workerVisibilityReader{t: t, ctx: ctx, owner: principal.UserID, id: workerID}
	if err := RequireWorker(ctx, r, principal, workerID); err != nil || r.calls != 1 {
		t.Fatalf("allowed Worker: %v calls=%d", err, r.calls)
	}
	r.err = model.ErrNotFound
	assertFault(t, RequireWorker(ctx, r, principal, workerID), "forbidden")
	r.err = errors.New("storage failed")
	if err := RequireWorker(ctx, r, principal, workerID); !errors.Is(err, r.err) {
		t.Fatalf("lost Worker lookup error: %v", err)
	}
}

func TestDefinitionAuthorizationRejectsInvalidProfileAndPreservesFixedProfiles(t *testing.T) {
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	for _, tc := range []struct {
		profile model.CredentialPolicyProfile
		kind    model.CredentialKind
		valid   bool
	}{
		{model.SessionProfile, model.SessionCredential, true},
		{model.OAuthAPIProfile, model.OAuthCredential, true},
		{model.ScopedPATProfile, model.PATCredential, false},
		{model.ScopedMCPProfile, model.OAuthCredential, false},
		{model.OAuthAPIProfile, model.PATCredential, false},
		{"", model.SessionCredential, false},
	} {
		principal.Kind = tc.kind
		auth := model.CredentialAuthorization{Principal: principal, Profile: tc.profile}
		err := RequireDefinition(auth, scopepolicy.BotRead, scopepolicy.BotWrite, scopepolicy.BotDelete)
		if (err == nil) != tc.valid {
			t.Errorf("profile %s kind %s: %v", tc.profile, tc.kind, err)
		}
		if err := RequireDefinition(auth); err == nil {
			t.Errorf("profile %s accepted no operation", tc.profile)
		}
		if err := RequireDefinition(auth, scopepolicy.Operation("unknown")); err == nil {
			t.Errorf("profile %s accepted unknown operation", tc.profile)
		}
	}
}
