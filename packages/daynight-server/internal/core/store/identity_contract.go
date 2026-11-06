package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// IdentityWriter binds identity and personal-team operations to one transaction.
// A scope and its DAOs are valid only during the callback.
type IdentityWriter interface {
	WriteIdentity(context.Context, func(IdentityScope) error) (Completion, error)
}

type IdentityScope interface {
	IdentityDAO() IdentityDAO
	PersonalTeamDAO() PersonalTeamDAO
}

type IdentityDAO interface {
	CleanupCredentials(context.Context, time.Time) error
	InsertLogin(context.Context, model.LoginTransaction) error
	ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error)
	UpsertUser(context.Context, model.User, time.Time) (model.User, error)
	InsertSession(context.Context, model.Session) error
	Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
	IdentityUser(context.Context, string) (model.User, PersonalTeamFacts, error)
	DeleteSession(context.Context, model.Principal) error
	LockSession(context.Context, model.Principal, time.Time) error
	InsertPAT(context.Context, model.PersonalAccessToken) error
	ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error)
	DeletePAT(context.Context, string, string) error
	LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error)
	SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error)
	PruneDeviceRates(context.Context, time.Time) error
	IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error)
	PruneDevices(context.Context, time.Time) error
	InsertDevice(context.Context, model.DeviceAuthorization) error
	DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error)
	LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error)
	SetDeviceDecision(context.Context, string, string, string) error
	DelayDevicePoll(context.Context, string, time.Time, bool) error
	ConsumeDevice(context.Context, string) error
}

type PersonalTeamDAO interface {
	InsertPersonalTeam(context.Context, string, string, time.Time) (bool, error)
	InsertPersonalOwner(context.Context, string, string, time.Time) error
	PersonalTeam(context.Context, string) (PersonalTeamFacts, error)
}

// PersonalTeamFacts are the membership facts observed for a user's team.
// An empty ID means that the team does not exist.
type PersonalTeamFacts struct {
	ID              string
	MemberCount     int64
	OwnerAdminCount int64
}
