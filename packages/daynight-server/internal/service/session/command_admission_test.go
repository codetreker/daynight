package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type commandSourceFunc func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)

func (f commandSourceFunc) SessionWrite(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
	return f(ctx, scope, p)
}

func TestCommandAuthorizationUsesTransactionActorAndCurrentPolicy(t *testing.T) {
	ctx := context.WithValue(t.Context(), struct{}{}, "transaction")
	scope := &receiptScope{}
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:send"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("credential read failed")
	for _, tc := range []struct {
		name      string
		auth      model.CredentialAuthorization
		sourceErr error
		operation scopepolicy.Operation
		wantCode  string
		wantErr   bool
	}{
		{"send", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionSend, "", false},
		{"read denied", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionRead, "insufficient_scope", true},
		{"missing policy", model.CredentialAuthorization{Principal: actor, Profile: model.ScopedPATProfile}, nil, scopepolicy.SessionSend, "", true},
		{"identity changed", model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}, Profile: model.ScopedPATProfile, Policy: &policy}, nil, scopepolicy.SessionSend, "", true},
		{"source failed", model.CredentialAuthorization{}, cause, scopepolicy.SessionSend, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := 0
			source := commandSourceFunc(func(gotCtx context.Context, gotScope store.SessionScope, got model.Principal) (model.CredentialAuthorization, error) {
				called++
				if gotCtx != ctx || gotScope != scope || got != actor {
					t.Fatal("transaction or actor changed")
				}
				return tc.auth, tc.sourceErr
			})
			err := requireCommandAuthorization(ctx, source, scope, actor, tc.operation)
			if called != 1 || (err != nil) != tc.wantErr {
				t.Fatalf("calls %d, error %v", called, err)
			}
			if tc.sourceErr != nil && !errors.Is(err, cause) {
				t.Fatalf("lost cause: %v", err)
			}
			if tc.wantCode != "" {
				requireServiceError(t, err, tc.wantCode)
			}
		})
	}
	if _, err := NewScopedCommands(nil, nil, nil); err == nil {
		t.Fatal("missing source accepted")
	}
}

func TestTransactionCommandAuthorizationRequiresCredentialCapability(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err := (TransactionCommandAuthorization{}).SessionWrite(t.Context(), &receiptScope{}, actor)
	if err == nil {
		t.Fatal("missing transaction credential capability accepted")
	}
	browser := model.Principal{Kind: model.SessionCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
	auth, err := (TransactionCommandAuthorization{}).SessionWrite(t.Context(), &receiptScope{}, browser)
	if err != nil || auth.Principal != browser || auth.Profile != model.SessionProfile || auth.Validate() != nil {
		t.Fatalf("browser profile: %+v %v", auth, err)
	}
}

type commandCredentialScope struct {
	store.SessionScope
	pat   store.PATScopeDAO
	clock store.PATManagementDAO
	oauth store.OAuthScopeDAO
}

func (s commandCredentialScope) SessionPATScopeDAO() store.PATScopeDAO           { return s.pat }
func (s commandCredentialScope) SessionPATManagementDAO() store.PATManagementDAO { return s.clock }
func (s commandCredentialScope) SessionOAuthScopeDAO() store.OAuthScopeDAO       { return s.oauth }

type commandPATDAO struct {
	store.PATScopeDAO
	read func(context.Context, string, string) (model.PersonalAccessToken, error)
}

func (d commandPATDAO) ReadLockedPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	return d.read(ctx, user, id)
}

type commandClock struct {
	store.PATManagementDAO
	now time.Time
}

func (d commandClock) FreshPATTime(_ context.Context, _ time.Time) (time.Time, error) {
	return d.now, nil
}

type commandOAuthDAO struct {
	store.OAuthScopeDAO
	read func(context.Context, model.Principal, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error)
}

func (d commandOAuthDAO) LockScopedAccess(ctx context.Context, p model.Principal, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	return d.read(ctx, p, bindings, now)
}

func TestTransactionCommandAuthorizationReadsCurrentPolicies(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	pat := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	oauthActor := model.Principal{Kind: model.OAuthCredential, UserID: pat.UserID, CredentialID: uuid.NewString()}
	patPolicy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:send"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	mcpPolicy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"session:send"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("credential backend failure")
	source := TransactionCommandAuthorization{Origin: "https://example.test", Now: func() time.Time { return now }}
	for _, tc := range []struct {
		name        string
		actor       model.Principal
		patToken    model.PersonalAccessToken
		access      store.OAuthAccessIdentity
		readErr     error
		wantProfile model.CredentialPolicyProfile
		wantCode    string
		wantErr     bool
	}{
		{name: "PAT policy", actor: pat, patToken: model.PersonalAccessToken{ID: pat.CredentialID, UserID: pat.UserID, ScopePolicy: &patPolicy}, wantProfile: model.ScopedPATProfile},
		{name: "PAT failure", actor: pat, readErr: failure, wantErr: true},
		{name: "MCP policy", actor: oauthActor, access: store.OAuthAccessIdentity{Principal: oauthActor, ScopePolicy: &mcpPolicy}, wantProfile: model.ScopedMCPProfile},
		{name: "fixed API profile", actor: oauthActor, access: store.OAuthAccessIdentity{Principal: oauthActor}, wantProfile: model.OAuthAPIProfile},
		{name: "expired OAuth", actor: oauthActor, readErr: model.ErrNotFound, wantCode: "unauthenticated", wantErr: true},
		{name: "OAuth failure", actor: oauthActor, readErr: failure, wantErr: true},
		{name: "changed OAuth actor", actor: oauthActor, access: store.OAuthAccessIdentity{Principal: pat}, wantCode: "unauthenticated", wantErr: true},
		{name: "invalid OAuth policy", actor: oauthActor, access: store.OAuthAccessIdentity{Principal: oauthActor, ScopePolicy: &patPolicy}, wantErr: true},
		{name: "invalid credential", actor: model.Principal{Kind: "invalid"}, wantCode: "unauthenticated", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			scope := commandCredentialScope{
				pat: commandPATDAO{read: func(_ context.Context, user, id string) (model.PersonalAccessToken, error) {
					calls++
					if user != tc.actor.UserID || id != tc.actor.CredentialID {
						t.Fatal("PAT actor changed")
					}
					return tc.patToken, tc.readErr
				}},
				clock: commandClock{now: now},
				oauth: commandOAuthDAO{read: func(_ context.Context, actor model.Principal, bindings []store.OAuthBinding, at time.Time) (store.OAuthAccessIdentity, error) {
					calls++
					if actor != tc.actor || !at.Equal(now) || len(bindings) != 2 || bindings[0].Resource != "https://example.test/api/v1" || bindings[1].Resource != "https://example.test/mcp" {
						t.Fatalf("OAuth identity or bindings changed: %+v %+v %v", actor, bindings, at)
					}
					return tc.access, tc.readErr
				}},
			}
			auth, err := source.SessionWrite(t.Context(), scope, tc.actor)
			if (err != nil) != tc.wantErr {
				t.Fatalf("authorization: %+v %v", auth, err)
			}
			if !tc.wantErr && (auth.Principal != tc.actor || auth.Profile != tc.wantProfile || auth.Validate() != nil) {
				t.Fatalf("incorrect authorization: %+v", auth)
			}
			if tc.wantCode != "" {
				requireServiceError(t, err, tc.wantCode)
			}
			if tc.readErr == failure && !errors.Is(err, failure) {
				t.Fatalf("lost error: %v", err)
			}
			wantCalls := 1
			if tc.actor.Kind == "invalid" {
				wantCalls = 0
			}
			if calls != wantCalls {
				t.Fatalf("credential calls %d, want %d", calls, wantCalls)
			}
		})
	}
}
