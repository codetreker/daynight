package server

import (
	"context"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"net/url"
	"testing"
)

type operationHTTPIdentity struct {
	t                 *testing.T
	CallbackURLFn     func() string
	ValidateLoginFn   func(string, string) error
	StartLoginFn      func(context.Context, string, string, string) (identitycore.LoginStart, error)
	CompleteLoginFn   func(context.Context, url.Values, string) (identitycore.LoginCompletion, error)
	AuthenticateFn    func(context.Context, model.CredentialKind, string) (model.Principal, error)
	UserFn            func(context.Context, model.Principal) (model.User, error)
	LogoutFn          func(context.Context, model.Principal) error
	CreatePATFn       func(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error)
	ListPATsFn        func(context.Context, model.Principal) ([]model.PersonalAccessToken, error)
	RevokePATFn       func(context.Context, model.Principal, string) error
	UpdatePATExpiryFn func(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error)
	ProvidersFn       func(context.Context) ([]string, error)
	StartDeviceFn     func(context.Context, string, string) (identitycore.DeviceStart, error)
	InspectDeviceFn   func(context.Context, model.Principal, string) (identitycore.DeviceInspection, error)
	DecideDeviceFn    func(context.Context, model.Principal, string, string, string) error
	RedeemDeviceFn    func(context.Context, string, string, string, string) (identitycore.MintedPAT, error)
	LogoutDeviceFn    func(context.Context, model.Principal) error
	PersonalTeamIDFn  func(context.Context, model.Principal) (string, error)
}

var _ application.IdentityOperations = (*operationHTTPIdentity)(nil)

func (o *operationHTTPIdentity) CallbackURL() string {
	if o.CallbackURLFn == nil {
		unexpectedHTTPCall(o.t, "Identity.CallbackURL")
	}
	return o.CallbackURLFn()
}

func (o *operationHTTPIdentity) ValidateLogin(a0 string, a1 string) error {
	if o.ValidateLoginFn == nil {
		unexpectedHTTPCall(o.t, "Identity.ValidateLogin")
	}
	return o.ValidateLoginFn(a0, a1)
}

func (o *operationHTTPIdentity) StartLogin(a0 context.Context, a1 string, a2 string, a3 string) (identitycore.LoginStart, error) {
	if o.StartLoginFn == nil {
		unexpectedHTTPCall(o.t, "Identity.StartLogin")
	}
	return o.StartLoginFn(a0, a1, a2, a3)
}

func (o *operationHTTPIdentity) CompleteLogin(a0 context.Context, a1 url.Values, a2 string) (identitycore.LoginCompletion, error) {
	if o.CompleteLoginFn == nil {
		unexpectedHTTPCall(o.t, "Identity.CompleteLogin")
	}
	return o.CompleteLoginFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) Authenticate(a0 context.Context, a1 model.CredentialKind, a2 string) (model.Principal, error) {
	if o.AuthenticateFn == nil {
		unexpectedHTTPCall(o.t, "Identity.Authenticate")
	}
	return o.AuthenticateFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) User(a0 context.Context, a1 model.Principal) (model.User, error) {
	if o.UserFn == nil {
		unexpectedHTTPCall(o.t, "Identity.User")
	}
	return o.UserFn(a0, a1)
}

func (o *operationHTTPIdentity) Logout(a0 context.Context, a1 model.Principal) error {
	if o.LogoutFn == nil {
		unexpectedHTTPCall(o.t, "Identity.Logout")
	}
	return o.LogoutFn(a0, a1)
}

func (o *operationHTTPIdentity) CreatePAT(a0 context.Context, a1 model.Principal, a2 identitycore.CreatePAT) (identitycore.MintedPAT, error) {
	if o.CreatePATFn == nil {
		unexpectedHTTPCall(o.t, "Identity.CreatePAT")
	}
	return o.CreatePATFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) ListPATs(a0 context.Context, a1 model.Principal) ([]model.PersonalAccessToken, error) {
	if o.ListPATsFn == nil {
		unexpectedHTTPCall(o.t, "Identity.ListPATs")
	}
	return o.ListPATsFn(a0, a1)
}

func (o *operationHTTPIdentity) RevokePAT(a0 context.Context, a1 model.Principal, a2 string) error {
	if o.RevokePATFn == nil {
		unexpectedHTTPCall(o.t, "Identity.RevokePAT")
	}
	return o.RevokePATFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) UpdatePATExpiry(a0 context.Context, a1 model.Principal, a2 string, a3 identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	if o.UpdatePATExpiryFn == nil {
		unexpectedHTTPCall(o.t, "Identity.UpdatePATExpiry")
	}
	return o.UpdatePATExpiryFn(a0, a1, a2, a3)
}

func (o *operationHTTPIdentity) Providers(a0 context.Context) ([]string, error) {
	if o.ProvidersFn == nil {
		unexpectedHTTPCall(o.t, "Identity.Providers")
	}
	return o.ProvidersFn(a0)
}

func (o *operationHTTPIdentity) StartDevice(a0 context.Context, a1 string, a2 string) (identitycore.DeviceStart, error) {
	if o.StartDeviceFn == nil {
		unexpectedHTTPCall(o.t, "Identity.StartDevice")
	}
	return o.StartDeviceFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) InspectDevice(a0 context.Context, a1 model.Principal, a2 string) (identitycore.DeviceInspection, error) {
	if o.InspectDeviceFn == nil {
		unexpectedHTTPCall(o.t, "Identity.InspectDevice")
	}
	return o.InspectDeviceFn(a0, a1, a2)
}

func (o *operationHTTPIdentity) DecideDevice(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) error {
	if o.DecideDeviceFn == nil {
		unexpectedHTTPCall(o.t, "Identity.DecideDevice")
	}
	return o.DecideDeviceFn(a0, a1, a2, a3, a4)
}

func (o *operationHTTPIdentity) RedeemDevice(a0 context.Context, a1 string, a2 string, a3 string, a4 string) (identitycore.MintedPAT, error) {
	if o.RedeemDeviceFn == nil {
		unexpectedHTTPCall(o.t, "Identity.RedeemDevice")
	}
	return o.RedeemDeviceFn(a0, a1, a2, a3, a4)
}

func (o *operationHTTPIdentity) LogoutDevice(a0 context.Context, a1 model.Principal) error {
	if o.LogoutDeviceFn == nil {
		unexpectedHTTPCall(o.t, "Identity.LogoutDevice")
	}
	return o.LogoutDeviceFn(a0, a1)
}

func (o *operationHTTPIdentity) PersonalTeamID(a0 context.Context, a1 model.Principal) (string, error) {
	if o.PersonalTeamIDFn == nil {
		unexpectedHTTPCall(o.t, "Identity.PersonalTeamID")
	}
	return o.PersonalTeamIDFn(a0, a1)
}

func newOperationHTTPIdentity(t *testing.T, principal model.Principal) *operationHTTPIdentity {
	t.Helper()
	return &operationHTTPIdentity{t: t,
		CallbackURLFn: func() string { return configuredTestConfig().UniAuthCallbackURL },
		AuthenticateFn: func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
			requireOperationHTTPContext(t, ctx)
			if kind != principal.Kind || token != httpTestToken(kind) {
				unexpectedHTTPCall(t, "Identity.Authenticate credential")
			}
			return principal, nil
		},
	}
}
