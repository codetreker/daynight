package auth

import (
	"context"
	"net/url"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type identityOperations interface {
	CallbackURL() string
	ValidateLogin(string, string) error
	StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error)
	CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error)
	Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error)
	User(context.Context, model.Principal) (model.User, error)
	Logout(context.Context, model.Principal) error
	CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error)
	ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error)
	RevokePAT(context.Context, model.Principal, string) error
	UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error)
	Providers(context.Context) ([]string, error)
	StartDevice(context.Context, string, string) (identitycore.DeviceStart, error)
	InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error)
	DecideDevice(context.Context, model.Principal, string, string, string) error
	RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error)
	LogoutDevice(context.Context, model.Principal) error
}
