package identity

import (
	"context"
	"errors"
	"io"
	"net/url"
	"time"

	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// Identity coordinates the identity module, upstream claims, and transactions.
type Identity struct {
	writer      store.IdentityWriter
	ops         identityOperations
	client      *uniauth.Client
	callbackURL string
	now         func() time.Time
}

type identityOperations struct {
	ensureUser               func(context.Context, store.IdentityDAO, model.User, time.Time) (model.User, bool, error)
	patchUser                func(context.Context, store.IdentityDAO, string, model.UserProfilePatch) (model.User, error)
	lockProfileCredential    func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error
	validateProfilePatch     func(model.UserProfilePatch) error
	validateExternalUser     func(model.User) (model.User, error)
	admitCompleteUser        func(model.User, bool) error
	validateLogin            func(provider, returnPath string) error
	startLogin               func(provider, returnPath string, now time.Time) (core.LoginStart, model.LoginTransaction, error)
	createLogin              func(ctx context.Context, dao store.IdentityDAO, pending model.LoginTransaction, appNow time.Time) (time.Time, error)
	consumeLogin             func(ctx context.Context, dao store.IdentityDAO, state, binding string, now time.Time) (model.LoginTransaction, error)
	newSession               func(now time.Time) (model.Session, string)
	completeLogin            func(ctx context.Context, dao store.IdentityDAO, user model.User, now time.Time) (model.User, error)
	createSession            func(ctx context.Context, dao store.IdentityDAO, session model.Session) error
	authenticate             func(ctx context.Context, dao store.IdentityDAO, kind model.CredentialKind, value string, now time.Time) (model.Principal, error)
	user                     func(ctx context.Context, dao store.IdentityDAO, p model.Principal) (model.User, store.PersonalTeamFacts, error)
	personalTeam             func(ctx context.Context, dao store.IdentityDAO, p model.Principal) (store.PersonalTeamFacts, error)
	logout                   func(ctx context.Context, dao store.IdentityDAO, p model.Principal) error
	createPAT                func(ctx context.Context, dao store.IdentityDAO, p model.Principal, input core.CreatePAT, now time.Time) (core.MintedPAT, error)
	listPATs                 func(ctx context.Context, dao store.IdentityDAO, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error)
	revokePAT                func(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string, now time.Time) error
	updatePATExpiry          func(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string, input core.UpdatePATExpiry, now time.Time) (model.PersonalAccessToken, error)
	providers                func(providers []string, code string, cause error) ([]string, error)
	deviceRate               func(ctx context.Context, dao store.IdentityDAO, operation, actor string, globalLimit, actorLimit int, now time.Time) error
	startDevice              func(ctx context.Context, dao store.IdentityDAO, clientID string, now time.Time) (core.DeviceStart, error)
	inspectDevice            func(ctx context.Context, dao store.IdentityDAO, p model.Principal, code string, now time.Time) (model.DeviceAuthorization, error)
	deviceInspection         func(d model.DeviceAuthorization, now time.Time) core.DeviceInspection
	decideDevice             func(ctx context.Context, dao store.IdentityDAO, p model.Principal, code, decision, expectedUserID string, now time.Time) error
	redeemDevice             func(ctx context.Context, dao store.IdentityDAO, clientID, grantType, code, deviceName string, now time.Time) (core.MintedPAT, error)
	logoutDevice             func(ctx context.Context, dao store.IdentityDAO, p model.Principal) error
	validateCallback         func(query url.Values, binding string) error
	validateProvider         func(expected, actual string, mismatch error) error
	admitProfileFields       func(profile model.User) error
	validateCredential       func(kind model.CredentialKind, value string) error
	validateSession          func(p model.Principal) error
	validateCreatePAT        func(p model.Principal, input core.CreatePAT, now time.Time) (*time.Time, error)
	validateRevokePAT        func(p model.Principal, id string) (string, error)
	validateUpdatePATExpiry  func(p model.Principal, id string, input core.UpdatePATExpiry, now time.Time) (string, *time.Time, error)
	validateDeviceClient     func(id string) error
	validateDeviceBrowser    func(p model.Principal) error
	validateDeviceDecision   func(p model.Principal, code, decision, expectedUserID string) (string, string, error)
	validateDeviceRedemption func(clientID, grantType, code, deviceName string) error
	validateDeviceLogout     func(p model.Principal) error
	bootstrapPersonalTeam    func(context.Context, store.PersonalTeamDAO, string, time.Time) (model.TeamRef, error)
	validatePersonalTeam     func(store.PersonalTeamFacts) error
}

func New(writer store.IdentityWriter, client *uniauth.Client, callbackURL string) *Identity {
	module := core.NewIdentity(callbackURL)
	return &Identity{writer: writer, client: client, callbackURL: callbackURL, now: time.Now, ops: identityOperations{
		ensureUser:               module.EnsureUser,
		patchUser:                module.PatchUser,
		lockProfileCredential:    module.LockProfileCredential,
		validateProfilePatch:     core.ValidateProfilePatch,
		validateExternalUser:     core.ValidateExternalUser,
		admitCompleteUser:        core.AdmitCompleteUser,
		validateLogin:            module.ValidateLogin,
		startLogin:               module.StartLogin,
		createLogin:              module.CreateLogin,
		consumeLogin:             module.ConsumeLogin,
		newSession:               module.NewSession,
		completeLogin:            module.CompleteLogin,
		createSession:            module.CreateSession,
		authenticate:             module.Authenticate,
		user:                     module.User,
		personalTeam:             module.PersonalTeam,
		logout:                   module.Logout,
		createPAT:                module.CreatePAT,
		listPATs:                 module.ListPATs,
		revokePAT:                module.RevokePAT,
		updatePATExpiry:          module.UpdatePATExpiry,
		providers:                module.Providers,
		deviceRate:               module.DeviceRate,
		startDevice:              module.StartDevice,
		inspectDevice:            module.InspectDevice,
		deviceInspection:         module.DeviceInspection,
		decideDevice:             module.DecideDevice,
		redeemDevice:             module.RedeemDevice,
		logoutDevice:             module.LogoutDevice,
		validateCallback:         core.ValidateCallback,
		validateProvider:         core.ValidateProvider,
		admitProfileFields:       core.AdmitProfileFields,
		validateCredential:       core.ValidateCredential,
		validateSession:          core.ValidateSession,
		validateCreatePAT:        core.ValidateCreatePAT,
		validateRevokePAT:        core.ValidateRevokePAT,
		validateUpdatePATExpiry:  core.ValidateUpdatePATExpiry,
		validateDeviceClient:     core.ValidateDeviceClient,
		validateDeviceBrowser:    core.ValidateDeviceBrowser,
		validateDeviceDecision:   core.ValidateDeviceDecision,
		validateDeviceRedemption: core.ValidateDeviceRedemption,
		validateDeviceLogout:     core.ValidateDeviceLogout,
		bootstrapPersonalTeam:    team.BootstrapPersonalTeam,
		validatePersonalTeam:     team.ValidatePersonalTeam,
	}}
}
func (s *Identity) CallbackURL() string { return s.callbackURL }

// A domain rejection can accompany useful writes (such as a poll delay). The
// transaction must finish successfully before that rejection is returned.
func (s *Identity) run(ctx context.Context, operation func(store.IdentityScope) error) error {
	var rejection error
	completion, err := s.writer.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		err := operation(scope)
		if failed, _ := store.DatabaseErrorFacts(err); failed {
			return err
		}
		var transaction *store.TransactionError
		if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
			return err
		}
		var fault *model.Fault
		var grant *core.DeviceGrantError
		if errors.As(err, &fault) || errors.As(err, &grant) {
			rejection = err
			return nil
		}
		return err
	})
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("identity transaction did not confirm commit")
	}
	return rejection
}
func (s *Identity) ValidateLogin(provider, returnPath string) error {
	return s.ops.validateLogin(provider, returnPath)
}

func (s *Identity) StartLogin(ctx context.Context, provider, returnPath, browserScope string) (core.LoginStart, error) {
	now := s.now().UTC()
	result, pending, err := s.ops.startLogin(provider, returnPath, now)
	if err != nil {
		return core.LoginStart{}, err
	}
	if !secret.Valid(browserScope, "") {
		return core.LoginStart{}, &model.Fault{Code: "invalid_input", Message: "Invalid login browser scope."}
	}
	pending.ScopeHash = secret.Hash(browserScope)
	result.AuthorizationURL, err = s.client.AuthorizationURL(uniauth.AuthorizationRequest{Provider: uniauth.Provider(provider), RedirectURI: s.CallbackURL(), State: result.State})
	if err != nil {
		return core.LoginStart{}, err
	}
	err = s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result.ExpiresAt, err = s.ops.createLogin(ctx, scope.IdentityDAO(), pending, s.now().UTC())
		return err
	})
	if err != nil {
		return core.LoginStart{}, err
	}
	return result, nil
}
func (s *Identity) CompleteLogin(ctx context.Context, query url.Values, binding string) (core.LoginCompletion, error) {
	if err := s.ops.validateCallback(query, binding); err != nil {
		return core.LoginCompletion{}, err
	}
	code, callbackErr := uniauth.ParseCallback(query, query.Get("state"))
	if callbackErr != nil {
		var failure *uniauth.CallbackError
		if !errors.As(callbackErr, &failure) || failure.Code == "invalid_callback" || failure.Code == "state_mismatch" {
			return core.LoginCompletion{}, core.CallbackFailure(callbackErr)
		}
	}
	var pending model.LoginTransaction
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		pending, err = s.ops.consumeLogin(ctx, scope.IdentityDAO(), query.Get("state"), binding, s.now().UTC())
		return err
	})
	if err != nil {
		return core.LoginCompletion{}, err
	}
	partial := core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath}
	if callbackErr != nil {
		return partial, core.CallbackFailure(callbackErr)
	}
	claim, cancel := context.WithTimeout(ctx, core.UpstreamTimeout)
	defer cancel()
	profile, err := s.client.Retrieve(claim, code)
	if err != nil {
		var protocol *uniauth.ProtocolError
		if errors.As(err, &protocol) {
			return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
		}
		return partial, err
	}
	if err := s.ops.validateProvider(pending.Provider, string(profile.Provider), &uniauth.ProtocolError{Reason: "provider_mismatch"}); err != nil {
		return partial, err
	}
	normalized := profileprotocol.Profile{ID: profile.ID, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name, AvatarURL: profile.AvatarURL}
	user := profileprotocol.User(normalized)
	if err := s.ops.admitProfileFields(user); err != nil {
		return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
	}
	if _, err := profileprotocol.Encode(io.Discard, normalized, core.MaxProfileJSONBytes); err != nil {
		return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
	}
	user.UniAuthID, err = core.CanonicalUniAuthID(user.UniAuthID)
	if err != nil {
		return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
	}
	now := s.now().UTC()
	session, value := s.ops.newSession(now)
	result := core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath, Secret: value, Session: session}
	var admissionError error
	err = s.strict(ctx, func(scope store.IdentityScope) error {
		var err error
		result.User, err = s.ops.completeLogin(ctx, scope.IdentityDAO(), user, now)
		if err != nil {
			return err
		}
		if err := s.ops.admitCompleteUser(result.User, false); err != nil {
			admissionError = err
			return err
		}
		result.User.PersonalTeam, err = s.ops.bootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), result.User.ID, now)
		if err != nil {
			return err
		}
		var facts store.PersonalTeamFacts
		result.User, facts, err = s.ops.user(ctx, scope.IdentityDAO(), model.Principal{UserID: result.User.ID})
		if err != nil {
			return err
		}
		if err := s.ops.validatePersonalTeam(facts); err != nil {
			return err
		}
		result.User.PersonalTeam.ID, result.User.PersonalTeam.Kind = facts.ID, "personal"
		if err := s.ops.admitCompleteUser(result.User, true); err != nil {
			admissionError = err
			return err
		}
		result.Session.UserID = result.User.ID
		return s.ops.createSession(ctx, scope.IdentityDAO(), result.Session)
	})
	if err != nil {
		// Only a cleanly rolled-back admission refusal is an upstream profile
		// error. Preserve transaction and cleanup failures as separate facts.
		if admissionError != nil && errors.Is(err, admissionError) {
			var transaction *store.TransactionError
			databaseFailure, _ := store.DatabaseErrorFacts(err)
			if !databaseFailure && (!errors.As(err, &transaction) || (transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed && !transaction.CommitAttempted)) {
				return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
			}
		}
		return partial, err
	}
	return result, nil
}
func (s *Identity) Authenticate(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
	if err := s.ops.validateCredential(kind, value); err != nil {
		return model.Principal{}, err
	}
	var result model.Principal
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.authenticate(ctx, scope.IdentityDAO(), kind, value, s.now().UTC())
		return err
	})
	if err != nil {
		return model.Principal{}, err
	}
	return result, nil
}
func (s *Identity) User(ctx context.Context, p model.Principal) (model.User, error) {
	var result model.User
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		var facts store.PersonalTeamFacts
		result, facts, err = s.ops.user(ctx, scope.IdentityDAO(), p)
		if err != nil {
			return err
		}
		if err := s.ops.validatePersonalTeam(facts); err != nil {
			return errors.New("user Personal Team is missing or invalid")
		}
		result.PersonalTeam.ID, result.PersonalTeam.Kind = facts.ID, "personal"
		return nil
	})
	if err != nil {
		return model.User{}, err
	}
	return result, nil
}

// PersonalTeamID reads only the validated ownership facts, not user profile text.
func (s *Identity) PersonalTeamID(ctx context.Context, p model.Principal) (string, error) {
	var id string
	err := s.run(ctx, func(scope store.IdentityScope) error {
		facts, err := s.ops.personalTeam(ctx, scope.IdentityDAO(), p)
		if err != nil {
			return err
		}
		if err := s.ops.validatePersonalTeam(facts); err != nil {
			return errors.New("user Personal Team is missing or invalid")
		}
		id = facts.ID
		return nil
	})
	return id, err
}
func (s *Identity) Logout(ctx context.Context, p model.Principal) error {
	if err := s.ops.validateSession(p); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error { return s.ops.logout(ctx, scope.IdentityDAO(), p) })
}
func (s *Identity) CreatePAT(ctx context.Context, p model.Principal, input core.CreatePAT) (core.MintedPAT, error) {
	now := s.now().UTC()
	if _, err := s.ops.validateCreatePAT(p, input, now); err != nil {
		return core.MintedPAT{}, err
	}
	var result core.MintedPAT
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.createPAT(ctx, scope.IdentityDAO(), p, input, now)
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}
func (s *Identity) ListPATs(ctx context.Context, p model.Principal) ([]model.PersonalAccessToken, error) {
	if err := s.ops.validateSession(p); err != nil {
		return nil, err
	}
	var result []model.PersonalAccessToken
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.listPATs(ctx, scope.IdentityDAO(), p, s.now().UTC())
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Identity) RevokePAT(ctx context.Context, p model.Principal, id string) error {
	if _, err := s.ops.validateRevokePAT(p, id); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.ops.revokePAT(ctx, scope.IdentityDAO(), p, id, s.now().UTC())
	})
}
func (s *Identity) UpdatePATExpiry(ctx context.Context, p model.Principal, id string, input core.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	now := s.now().UTC()
	if _, _, err := s.ops.validateUpdatePATExpiry(p, id, input, now); err != nil {
		return model.PersonalAccessToken{}, err
	}
	var result model.PersonalAccessToken
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.updatePATExpiry(ctx, scope.IdentityDAO(), p, id, input, now)
		return err
	})
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	return result, nil
}
func (s *Identity) Providers(ctx context.Context) ([]string, error) {
	discovery, cancel := context.WithTimeout(ctx, core.UpstreamTimeout)
	defer cancel()
	providers, err := s.client.Providers(discovery, s.CallbackURL())
	code := "identity_unavailable"
	var upstream *uniauth.APIError
	if errors.As(err, &upstream) && (upstream.StatusCode == 400 || upstream.StatusCode == 401) {
		code = "identity_configuration"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		code = "identity_timeout"
	}
	result := make([]string, 0, len(providers))
	for _, provider := range providers {
		result = append(result, string(provider))
	}
	return s.ops.providers(result, code, err)
}
func (s *Identity) rate(ctx context.Context, operation, actor string, globalLimit, actorLimit int) error {
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.ops.deviceRate(ctx, scope.IdentityDAO(), operation, actor, globalLimit, actorLimit, s.now().UTC())
	})
}

func deviceCollision(err error) bool {
	failure, state := store.DatabaseErrorFacts(err)
	var transaction *store.TransactionError
	return failure && state == "23505" && errors.As(err, &transaction) && transaction.Phase == "operation" && !transaction.CleanupFailed && transaction.Outcome == store.TransactionNotCommitted
}

func (s *Identity) StartDevice(ctx context.Context, clientID, source string) (core.DeviceStart, error) {
	if err := s.ops.validateDeviceClient(clientID); err != nil {
		return core.DeviceStart{}, err
	}
	if err := s.rate(ctx, "device-create", source, 120, 30); err != nil {
		return core.DeviceStart{}, err
	}
	now := s.now().UTC()
	for range 3 {
		var result core.DeviceStart
		err := s.run(ctx, func(scope store.IdentityScope) error {
			var err error
			result, err = s.ops.startDevice(ctx, scope.IdentityDAO(), clientID, now)
			return err
		})
		if deviceCollision(err) {
			continue
		}
		if err != nil {
			return core.DeviceStart{}, err
		}
		return result, nil
	}
	return core.DeviceStart{}, errors.New("device authorization code generation exhausted collision attempts")
}
func (s *Identity) browserRate(ctx context.Context, p model.Principal) error {
	if err := s.ops.validateDeviceBrowser(p); err != nil {
		return err
	}
	return s.rate(ctx, "device-lookup", p.UserID, 120, 12)
}
func (s *Identity) InspectDevice(ctx context.Context, p model.Principal, code string) (core.DeviceInspection, error) {
	if err := s.browserRate(ctx, p); err != nil {
		return core.DeviceInspection{}, err
	}
	if _, err := core.NormalizeDeviceCode(code); err != nil {
		return core.DeviceInspection{}, err
	}
	var result model.DeviceAuthorization
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.inspectDevice(ctx, scope.IdentityDAO(), p, code, s.now().UTC())
		return err
	})
	if err != nil {
		return core.DeviceInspection{}, err
	}
	return s.ops.deviceInspection(result, s.now().UTC()), nil
}
func (s *Identity) DecideDevice(ctx context.Context, p model.Principal, code, decision, userID string) error {
	if err := s.browserRate(ctx, p); err != nil {
		return err
	}
	if _, _, err := s.ops.validateDeviceDecision(p, code, decision, userID); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.ops.decideDevice(ctx, scope.IdentityDAO(), p, code, decision, userID, s.now().UTC())
	})
}
func (s *Identity) RedeemDevice(ctx context.Context, clientID, grantType, code, name string) (core.MintedPAT, error) {
	if err := s.ops.validateDeviceRedemption(clientID, grantType, code, name); err != nil {
		return core.MintedPAT{}, err
	}
	var result core.MintedPAT
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.ops.redeemDevice(ctx, scope.IdentityDAO(), clientID, grantType, code, name, s.now().UTC())
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}
func (s *Identity) LogoutDevice(ctx context.Context, p model.Principal) error {
	if err := s.ops.validateDeviceLogout(p); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error { return s.ops.logoutDevice(ctx, scope.IdentityDAO(), p) })
}
