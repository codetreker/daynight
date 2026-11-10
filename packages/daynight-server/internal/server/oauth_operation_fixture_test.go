package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"testing"
	"time"
)

type oauthHTTPOperations struct {
	t                    *testing.T
	StartFn              func(context.Context, oauthservice.StartInput) (oauthservice.StartResult, error)
	InspectFn            func(context.Context, string, string, model.Principal) (oauthservice.AuthorizationView, error)
	DecideFn             func(context.Context, oauthservice.DecisionInput) (oauthservice.DecisionResult, error)
	RedeemCodeFn         func(context.Context, oauthservice.RedeemInput) (oauthservice.TokenResult, error)
	RegisterFn           func(context.Context, string, []byte) (core.ClientMetadata, error)
	RotateFn             func(context.Context, string, string, string, func(context.Context, string) error) (core.RotatedTokens, error)
	RevokePublicFn       func(context.Context, string, string) error
	AuthenticateAccessFn func(context.Context, string, string) (store.OAuthAccessIdentity, error)
	ListSessionGrantsFn  func(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error)
	RevokeSessionGrantFn func(context.Context, model.Principal, string) (bool, error)
}

func (o *oauthHTTPOperations) Start(ctx context.Context, in oauthservice.StartInput) (oauthservice.StartResult, error) {
	if o.StartFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.Start")
	}
	return o.StartFn(ctx, in)
}
func (o *oauthHTTPOperations) Inspect(ctx context.Context, id, binding string, p model.Principal) (oauthservice.AuthorizationView, error) {
	if o.InspectFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.Inspect")
	}
	return o.InspectFn(ctx, id, binding, p)
}
func (o *oauthHTTPOperations) Decide(ctx context.Context, in oauthservice.DecisionInput) (oauthservice.DecisionResult, error) {
	if o.DecideFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.Decide")
	}
	return o.DecideFn(ctx, in)
}
func (o *oauthHTTPOperations) RedeemCode(ctx context.Context, in oauthservice.RedeemInput) (oauthservice.TokenResult, error) {
	if o.RedeemCodeFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.RedeemCode")
	}
	return o.RedeemCodeFn(ctx, in)
}
func (o *oauthHTTPOperations) Register(ctx context.Context, source string, body []byte) (core.ClientMetadata, error) {
	if o.RegisterFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.Register")
	}
	return o.RegisterFn(ctx, source, body)
}
func (o *oauthHTTPOperations) Rotate(ctx context.Context, token, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
	if o.RotateFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.Rotate")
	}
	return o.RotateFn(ctx, token, client, resource, admit)
}
func (o *oauthHTTPOperations) RevokePublic(ctx context.Context, token, client string) error {
	if o.RevokePublicFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.RevokePublic")
	}
	return o.RevokePublicFn(ctx, token, client)
}
func (o *oauthHTTPOperations) AuthenticateAccess(ctx context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	if o.AuthenticateAccessFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.AuthenticateAccess")
	}
	return o.AuthenticateAccessFn(ctx, token, resource)
}

func (o *oauthHTTPOperations) ListSessionGrants(ctx context.Context, p model.Principal) ([]store.OAuthGrant, time.Time, error) {
	if o.ListSessionGrantsFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.ListSessionGrants")
	}
	return o.ListSessionGrantsFn(ctx, p)
}
func (o *oauthHTTPOperations) RevokeSessionGrant(ctx context.Context, p model.Principal, id string) (bool, error) {
	if o.RevokeSessionGrantFn == nil {
		unexpectedHTTPCall(o.t, "OAuth.RevokeSessionGrant")
	}
	return o.RevokeSessionGrantFn(ctx, p, id)
}
