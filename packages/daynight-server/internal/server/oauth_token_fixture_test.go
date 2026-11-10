package server

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tokenhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type oauthHTTPPermit struct {
	t       *testing.T
	ctx     context.Context
	fixture *oauthHTTPFixture
	calls   atomic.Int32
}

func (p *oauthHTTPPermit) TakeClient(ctx context.Context, id string) (bool, error) {
	if ctx != p.ctx {
		unexpectedHTTPCall(p.t, "OAuth permit changed request context")
	}
	if p.calls.Add(1) != 1 || id == "" || id == "wrong" {
		unexpectedHTTPCall(p.t, "OAuth verified client permit")
	}
	p.fixture.mu.Lock()
	p.fixture.Rates["oauth:token:client:"+id]++
	p.fixture.mu.Unlock()
	return true, nil
}
func (f *oauthHTTPFixture) admission(ctx context.Context, source string) (tokenhttp.ClientPermit, bool, error) {
	oauthHTTPDirectContext(f.t, ctx)
	oauthHTTPCheck(f.t, source, "127.0.0.1")
	f.mu.Lock()
	f.Rates["oauth:token:global"]++
	f.Rates["oauth:token:source:"+source]++
	f.mu.Unlock()
	return &oauthHTTPPermit{t: f.t, ctx: ctx, fixture: f}, true, nil
}

func oauthHTTPExpectAccess(t *testing.T, f *oauthHTTPFixture, token, resource string, p model.Principal, grant string, err error) {
	t.Helper()
	called := oauthHTTPCount(t, 1)
	f.Ops.AuthenticateAccessFn = func(ctx context.Context, actualToken, actualResource string) (store.OAuthAccessIdentity, error) {
		called()
		oauthHTTPContext(t, ctx)
		oauthHTTPCheck(t, []string{actualToken, actualResource}, []string{token, resource})
		return store.OAuthAccessIdentity{Principal: p, GrantID: grant}, err
	}
}
func oauthHTTPExpectedIssue(f *oauthHTTPFixture, row store.OAuthAuthorization) (oauthservice.TokenResult, store.OAuthFamilyIssue) {
	access, refresh := secret.Random("dnmcp_"), secret.Random("dnmcr_")
	issue := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: row.UserID, ClientID: row.ClientID, Resource: row.Resource, Scope: core.Scope, ClientSnapshot: bytes.Clone(row.Client), CreatedAt: f.Now, ExpiresAt: f.Now.Add(core.GrantLifetime)}, AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: f.Now.Add(core.AccessLifetime)}
	return oauthservice.TokenResult{AccessToken: access, RefreshToken: refresh, TokenType: "Bearer", Scope: core.Scope, ExpiresIn: int64(core.AccessLifetime / time.Second)}, issue
}
func oauthHTTPExpectRedeem(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, budget, replay, refused bool, issued *store.OAuthFamilyIssue, want oauthservice.RedeemInput) {
	t.Helper()
	row = oauthHTTPCloneAuthorization(row)
	called := oauthHTTPCount(t, 1)
	out, issue := oauthHTTPExpectedIssue(f, row)
	f.ExpectedTokens = out
	f.Ops.RedeemCodeFn = func(ctx context.Context, in oauthservice.RedeemInput) (oauthservice.TokenResult, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		expected := want
		expected.AdmitClient = nil
		actual := in
		actual.AdmitClient = nil
		oauthHTTPCheck(t, actual, expected)
		oauthHTTPCheck(t, secret.Hash(in.Code), row.CodeHash)
		if (in.AdmitClient != nil) != budget {
			unexpectedHTTPCall(t, "OAuth redemption verified-client callback")
		}
		if replay || refused {
			return oauthservice.TokenResult{}, core.ErrInvalidGrant
		}
		if budget {
			if err := in.AdmitClient(ctx, row.ClientID); err != nil {
				return oauthservice.TokenResult{}, err
			}
		}
		*issued = oauthHTTPCloneIssue(issue)
		return out, nil
	}
}
func oauthHTTPExpectRotate(t *testing.T, f *oauthHTTPFixture, token string, grant store.OAuthGrant, replay, wrongClient bool, rotation *store.OAuthRotation) {
	t.Helper()
	grant = oauthHTTPCloneGrant(grant)
	called := oauthHTTPCount(t, 1)
	access, refresh := secret.Random("dnmcp_"), secret.Random("dnmcr_")
	f.ExpectedTokens = oauthservice.TokenResult{AccessToken: access, RefreshToken: refresh, TokenType: "Bearer", Scope: core.Scope, ExpiresIn: int64(core.AccessLifetime / time.Second)}
	proposal := store.OAuthRotation{Grant: oauthHTTPCloneGrant(grant), OldHash: secret.Hash(token), AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), CreatedAt: f.Now, AccessExpiresAt: f.Now.Add(core.AccessLifetime)}
	f.Ops.RotateFn = func(ctx context.Context, actualToken, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		expectedClient := grant.ClientID
		if wrongClient {
			expectedClient = "wrong"
		}
		oauthHTTPCheck(t, []string{actualToken, client, resource}, []string{token, expectedClient, grant.Resource})
		if admit == nil {
			unexpectedHTTPCall(t, "OAuth refresh verified-client callback")
		}
		if wrongClient {
			return core.RotatedTokens{}, core.ErrInvalidGrant
		}
		if err := admit(ctx, grant.ClientID); err != nil {
			return core.RotatedTokens{}, err
		}
		if replay {
			return core.RotatedTokens{}, core.ErrInvalidGrant
		}
		*rotation = oauthHTTPCloneRotation(proposal)
		return core.RotatedTokens{AccessToken: access, RefreshToken: refresh, ExpiresIn: int64(core.AccessLifetime / time.Second)}, nil
	}
}
func oauthHTTPExpectRevoke(t *testing.T, f *oauthHTTPFixture, token string, grant store.OAuthGrant, wrongClient bool) {
	t.Helper()
	called := oauthHTTPCount(t, 1)
	client := grant.ClientID
	if wrongClient {
		client = "wrong"
	}
	f.Ops.RevokePublicFn = func(ctx context.Context, actualToken, actualClient string) error {
		called()
		oauthHTTPDirectContext(t, ctx)
		oauthHTTPCheck(t, []string{actualToken, actualClient}, []string{token, client})
		return nil
	}
}
func oauthHTTPConcurrentRedeem(t *testing.T, f *oauthHTTPFixture, approved store.OAuthAuthorization, issued *store.OAuthFamilyIssue, code string) {
	t.Helper()
	approved = oauthHTTPCloneAuthorization(approved)
	out, issue := oauthHTTPExpectedIssue(f, approved)
	f.ExpectedTokens = out
	var calls atomic.Int32
	returned := make(chan struct{})
	f.Ops.RedeemCodeFn = func(ctx context.Context, in oauthservice.RedeemInput) (oauthservice.TokenResult, error) {
		oauthHTTPDirectContext(t, ctx)
		actual := in
		actual.AdmitClient = nil
		oauthHTTPCheck(t, actual, oauthservice.RedeemInput{Code: code, ClientID: approved.ClientID, RedirectURI: approved.RedirectURI, Resource: approved.Resource, Verifier: strings.Repeat("v", 43)})
		oauthHTTPCheck(t, secret.Hash(in.Code), approved.CodeHash)
		if in.AdmitClient != nil {
			unexpectedHTTPCall(t, "code-only callback")
		}
		switch calls.Add(1) {
		case 1:
			*issued = oauthHTTPCloneIssue(issue)
			close(returned)
			return out, nil
		case 2:
			select {
			case <-returned:
			case <-ctx.Done():
				return oauthservice.TokenResult{}, ctx.Err()
			}
			return oauthservice.TokenResult{}, core.ErrInvalidGrant
		default:
			unexpectedHTTPCall(t, "extra concurrent redemption")
			return oauthservice.TokenResult{}, core.ErrInvalidGrant
		}
	}
	t.Cleanup(func() {
		if calls.Load() != 2 {
			t.Errorf("concurrent redemption calls=%d", calls.Load())
		}
	})
}

func oauthHTTPAssertTokens(t *testing.T, data []byte, want oauthservice.TokenResult) {
	t.Helper()
	var wire struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Type    string `json:"token_type"`
		Scope   string `json:"scope"`
		Expires int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	oauthHTTPCheck(t, oauthservice.TokenResult{AccessToken: wire.Access, RefreshToken: wire.Refresh, TokenType: wire.Type, Scope: wire.Scope, ExpiresIn: wire.Expires}, want)
}
