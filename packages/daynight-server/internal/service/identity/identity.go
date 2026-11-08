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
	writer store.IdentityWriter
	module *core.Identity
	client *uniauth.Client
	now    func() time.Time
}

func New(writer store.IdentityWriter, client *uniauth.Client, callbackURL string) *Identity {
	return &Identity{writer: writer, module: core.NewIdentity(callbackURL), client: client, now: time.Now}
}
func (s *Identity) CallbackURL() string { return s.module.CallbackURL() }

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
	return s.module.ValidateLogin(provider, returnPath)
}

func (s *Identity) StartLogin(ctx context.Context, provider, returnPath, browserScope string) (core.LoginStart, error) {
	now := s.now().UTC()
	result, pending, err := s.module.StartLogin(provider, returnPath, now)
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
		result.ExpiresAt, err = s.module.CreateLogin(ctx, scope.IdentityDAO(), pending, s.now().UTC())
		return err
	})
	if err != nil {
		return core.LoginStart{}, err
	}
	return result, nil
}
func (s *Identity) CompleteLogin(ctx context.Context, query url.Values, binding string) (core.LoginCompletion, error) {
	if err := core.ValidateCallback(query, binding); err != nil {
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
		pending, err = s.module.ConsumeLogin(ctx, scope.IdentityDAO(), query.Get("state"), binding, s.now().UTC())
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
	if err := core.ValidateProvider(pending.Provider, string(profile.Provider), &uniauth.ProtocolError{Reason: "provider_mismatch"}); err != nil {
		return partial, err
	}
	normalized := profileprotocol.Profile{ID: profile.ID, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name, AvatarURL: profile.AvatarURL}
	user := profileprotocol.User(normalized)
	if err := core.AdmitProfileFields(user); err != nil {
		return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
	}
	if _, err := profileprotocol.Encode(io.Discard, normalized, core.MaxProfileJSONBytes); err != nil {
		return partial, &model.IdentityProviderError{Code: "identity_unavailable", Cause: err}
	}
	now := s.now().UTC()
	session, value := s.module.NewSession(now)
	result := core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath, Secret: value, Session: session}
	err = s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result.User, err = s.module.CompleteLogin(ctx, scope.IdentityDAO(), user, now)
		if err != nil {
			return err
		}
		result.User.PersonalTeam, err = team.BootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), result.User.ID, now)
		if err != nil {
			return err
		}
		result.Session.UserID = result.User.ID
		return s.module.CreateSession(ctx, scope.IdentityDAO(), result.Session)
	})
	if err != nil {
		return partial, err
	}
	return result, nil
}
func (s *Identity) Authenticate(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
	if err := core.ValidateCredential(kind, value); err != nil {
		return model.Principal{}, err
	}
	var result model.Principal
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.module.Authenticate(ctx, scope.IdentityDAO(), kind, value, s.now().UTC())
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
		result, facts, err = s.module.User(ctx, scope.IdentityDAO(), p)
		if err != nil {
			return err
		}
		if err := team.ValidatePersonalTeam(facts); err != nil {
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
		facts, err := s.module.PersonalTeam(ctx, scope.IdentityDAO(), p)
		if err != nil {
			return err
		}
		if err := team.ValidatePersonalTeam(facts); err != nil {
			return errors.New("user Personal Team is missing or invalid")
		}
		id = facts.ID
		return nil
	})
	return id, err
}
func (s *Identity) Logout(ctx context.Context, p model.Principal) error {
	if err := core.ValidateSession(p); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error { return s.module.Logout(ctx, scope.IdentityDAO(), p) })
}
func (s *Identity) CreatePAT(ctx context.Context, p model.Principal, input core.CreatePAT) (core.MintedPAT, error) {
	now := s.now().UTC()
	if _, err := core.ValidateCreatePAT(p, input, now); err != nil {
		return core.MintedPAT{}, err
	}
	var result core.MintedPAT
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.module.CreatePAT(ctx, scope.IdentityDAO(), p, input, now)
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}
func (s *Identity) ListPATs(ctx context.Context, p model.Principal) ([]model.PersonalAccessToken, error) {
	if err := core.ValidateSession(p); err != nil {
		return nil, err
	}
	var result []model.PersonalAccessToken
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.module.ListPATs(ctx, scope.IdentityDAO(), p, s.now().UTC())
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Identity) RevokePAT(ctx context.Context, p model.Principal, id string) error {
	if _, err := core.ValidateRevokePAT(p, id); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.module.RevokePAT(ctx, scope.IdentityDAO(), p, id, s.now().UTC())
	})
}
func (s *Identity) UpdatePATExpiry(ctx context.Context, p model.Principal, id string, input core.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	now := s.now().UTC()
	if _, _, err := core.ValidateUpdatePATExpiry(p, id, input, now); err != nil {
		return model.PersonalAccessToken{}, err
	}
	var result model.PersonalAccessToken
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.module.UpdatePATExpiry(ctx, scope.IdentityDAO(), p, id, input, now)
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
	return s.module.Providers(result, code, err)
}
func (s *Identity) rate(ctx context.Context, operation, actor string, globalLimit, actorLimit int) error {
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.module.DeviceRate(ctx, scope.IdentityDAO(), operation, actor, globalLimit, actorLimit, s.now().UTC())
	})
}

func deviceCollision(err error) bool {
	failure, state := store.DatabaseErrorFacts(err)
	var transaction *store.TransactionError
	return failure && state == "23505" && errors.As(err, &transaction) && transaction.Phase == "operation" && !transaction.CleanupFailed && transaction.Outcome == store.TransactionNotCommitted
}

func (s *Identity) StartDevice(ctx context.Context, clientID, source string) (core.DeviceStart, error) {
	if err := core.ValidateDeviceClient(clientID); err != nil {
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
			result, err = s.module.StartDevice(ctx, scope.IdentityDAO(), clientID, now)
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
	if err := core.ValidateDeviceBrowser(p); err != nil {
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
		result, err = s.module.InspectDevice(ctx, scope.IdentityDAO(), p, code, s.now().UTC())
		return err
	})
	if err != nil {
		return core.DeviceInspection{}, err
	}
	return s.module.DeviceInspection(result, s.now().UTC()), nil
}
func (s *Identity) DecideDevice(ctx context.Context, p model.Principal, code, decision, userID string) error {
	if err := s.browserRate(ctx, p); err != nil {
		return err
	}
	if _, _, err := core.ValidateDeviceDecision(p, code, decision, userID); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error {
		return s.module.DecideDevice(ctx, scope.IdentityDAO(), p, code, decision, userID, s.now().UTC())
	})
}
func (s *Identity) RedeemDevice(ctx context.Context, clientID, grantType, code, name string) (core.MintedPAT, error) {
	if err := core.ValidateDeviceRedemption(clientID, grantType, code, name); err != nil {
		return core.MintedPAT{}, err
	}
	var result core.MintedPAT
	err := s.run(ctx, func(scope store.IdentityScope) error {
		var err error
		result, err = s.module.RedeemDevice(ctx, scope.IdentityDAO(), clientID, grantType, code, name, s.now().UTC())
		return err
	})
	if err != nil {
		return core.MintedPAT{}, err
	}
	return result, nil
}
func (s *Identity) LogoutDevice(ctx context.Context, p model.Principal) error {
	if err := core.ValidateDeviceLogout(p); err != nil {
		return err
	}
	return s.run(ctx, func(scope store.IdentityScope) error { return s.module.LogoutDevice(ctx, scope.IdentityDAO(), p) })
}
