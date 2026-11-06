package oauth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type StartInput struct {
	Source, ClientID, RedirectURI, ResponseType, Scope, Resource, State, CodeChallenge, CodeChallengeMethod string
	StatePresent                                                                                            bool
}
type StartResult struct{ RequestID, Binding string }
type AuthorizationView struct {
	RequestID        string `json:"requestId"`
	Status           string `json:"status"`
	UserID           string `json:"userId"`
	ClientName       string `json:"clientName"`
	ClientID         string `json:"clientId"`
	ClientProvenance string `json:"clientProvenance"`
	RedirectURI      string `json:"redirectUri"`
	Resource         string `json:"resource"`
	Scope            string `json:"scope"`
	CodeExpired      bool   `json:"codeExpired"`
}
type DecisionInput struct {
	RequestID, Binding, ExpectedUserID, Decision string
	Principal                                    model.Principal
}
type DecisionResult struct{ RedirectURI string }
type RedeemInput struct {
	Code, ClientID, RedirectURI, Resource, Verifier string
	// AdmitClient runs after the credential binding is verified, before any mutation.
	AdmitClient func(context.Context, string) error
}
type TokenResult struct {
	AccessToken, RefreshToken, TokenType, Scope string
	ExpiresIn                                   int64
}
type Authorizations struct {
	writer           store.AuthorizationWriter
	clients          *Clients
	admission        core.PublicAdmission
	issuer, resource string
	now              func() time.Time
}

func NewAuthorizations(writer store.AuthorizationWriter, clients *Clients, admission core.PublicAdmission, issuer string) (*Authorizations, error) {
	u, e := url.Parse(issuer)
	if writer == nil || clients == nil || e != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Path != "" || u.String() != issuer {
		return nil, core.ErrInvalidAuthorization
	}
	return &Authorizations{writer: writer, clients: clients, admission: admission, issuer: issuer, resource: issuer + "/mcp", now: time.Now}, nil
}
func (s *Authorizations) clock() time.Time { return s.now().UTC().Truncate(time.Microsecond) }
func completionError(c store.Completion, e error) error {
	if c.Outcome == store.TransactionUnknown {
		return fmt.Errorf("%w: transaction not confirmed", core.ErrAuthorizationUnknown)
	}
	if e != nil {
		return e
	}
	if c.Outcome != store.TransactionCommitted {
		return fmt.Errorf("authorization transaction not committed")
	}
	return nil
}
func canonicalID(id string) bool {
	c, e := model.CanonicalID(id)
	return e == nil && c == id && c != uuid.Nil.String()
}
func (s *Authorizations) Start(ctx context.Context, in StartInput) (StartResult, error) {
	allowed, e := s.admission.Take(ctx, "start", in.Source, "")
	if e != nil {
		return StartResult{}, e
	}
	if !allowed {
		return StartResult{}, core.ErrRateLimited
	}
	if in.ResponseType != "code" || in.Scope != core.Scope || in.Resource != s.resource || in.CodeChallengeMethod != "S256" || !core.ValidChallenge(in.CodeChallenge) || !core.ValidState(in.State) {
		return StartResult{}, core.ErrInvalidAuthorization
	}
	client, e := s.clients.Resolve(ctx, in.ClientID, in.RedirectURI)
	if e != nil {
		return StartResult{}, e
	}
	if _, e = core.CallbackURI(client.SelectedExactRedirect, nil); e != nil {
		return StartResult{}, e
	}
	raw, e := json.Marshal(client)
	if e != nil {
		return StartResult{}, e
	}
	now := s.clock()
	result := StartResult{RequestID: uuid.NewString(), Binding: secret.Random(core.BindingPrefix)}
	a := store.OAuthAuthorization{ID: result.RequestID, BindingHash: secret.Hash(result.Binding), Client: raw, ClientID: client.ClientID, RedirectURI: client.SelectedExactRedirect, Resource: in.Resource, Scope: in.Scope, Challenge: in.CodeChallenge, State: in.State, StatePresent: in.StatePresent || in.State != "", Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
	var inserted bool
	c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		var err error
		inserted, err = scope.AuthorizationDAO().InsertAuthorization(ctx, a, 10000, now)
		return err
	})
	if err := completionError(c, e); err != nil {
		return StartResult{}, err
	}
	if !inserted {
		return StartResult{}, core.ErrAuthorizationCapacity
	}
	return result, nil
}
func authorized(a store.OAuthAuthorization, binding string) bool {
	return secret.Valid(binding, core.BindingPrefix) && subtle.ConstantTimeCompare(a.BindingHash, secret.Hash(binding)) == 1
}
func validSession(p model.Principal) bool {
	return p.Kind == model.SessionCredential && canonicalID(p.UserID) && canonicalID(p.CredentialID)
}
func lockSession(ctx context.Context, dao store.IdentityDAO, principal model.Principal, now time.Time) error {
	err := dao.LockSession(ctx, principal, now)
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(nil)
	}
	return err
}

func (s *Authorizations) Inspect(ctx context.Context, id, binding string, principal model.Principal) (AuthorizationView, error) {
	if !validSession(principal) {
		return AuthorizationView{}, model.Unauthenticated(nil)
	}
	if !canonicalID(id) || !secret.Valid(binding, core.BindingPrefix) {
		return AuthorizationView{}, core.ErrInvalidAuthorization
	}
	var a store.OAuthAuthorization
	var now time.Time
	c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		var err error
		if err = lockSession(ctx, scope.IdentityDAO(), principal, s.clock()); err != nil {
			return err
		}
		a, err = scope.AuthorizationDAO().Authorization(ctx, id, false)
		if err != nil {
			return err
		}
		now, err = scope.AuthorizationDAO().FreshTime(ctx, s.clock())
		if err != nil {
			return err
		}
		return lockSession(ctx, scope.IdentityDAO(), principal, now)
	})
	if c.Outcome != store.TransactionUnknown && errors.Is(e, model.ErrNotFound) {
		return AuthorizationView{}, core.ErrInvalidAuthorization
	}
	if err := completionError(c, e); err != nil {
		return AuthorizationView{}, err
	}
	if !authorized(a, binding) {
		return AuthorizationView{}, core.ErrInvalidAuthorization
	}
	var client core.ValidatedClient
	if json.Unmarshal(a.Client, &client) != nil {
		return AuthorizationView{}, core.ErrInvalidAuthorization
	}
	status := a.Status
	if status == "pending" && !a.ExpiresAt.After(now) {
		status = "expired"
	}
	codeExpired := status == "approved" && (a.CodeExpiresAt == nil || !a.CodeExpiresAt.After(now))
	return AuthorizationView{RequestID: a.ID, Status: status, UserID: principal.UserID, ClientName: client.ClientName, ClientID: a.ClientID, ClientProvenance: client.Provenance, RedirectURI: a.RedirectURI, Resource: a.Resource, Scope: a.Scope, CodeExpired: codeExpired}, nil
}
func (s *Authorizations) Decide(ctx context.Context, in DecisionInput) (DecisionResult, error) {
	if !validSession(in.Principal) {
		return DecisionResult{}, model.Unauthenticated(nil)
	}
	if !canonicalID(in.RequestID) || in.Principal.UserID != in.ExpectedUserID || !secret.Valid(in.Binding, core.BindingPrefix) || (in.Decision != "approve" && in.Decision != "deny") {
		return DecisionResult{}, core.ErrInvalidAuthorization
	}
	var result DecisionResult
	c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		dao := scope.AuthorizationDAO()
		if err := lockSession(ctx, scope.IdentityDAO(), in.Principal, s.clock()); err != nil {
			return err
		}
		a, err := dao.Authorization(ctx, in.RequestID, true)
		if err != nil {
			return err
		}
		now, err := dao.FreshTime(ctx, s.clock())
		if err != nil {
			return err
		}
		if err = lockSession(ctx, scope.IdentityDAO(), in.Principal, now); err != nil {
			return err
		}
		if !authorized(a, in.Binding) || a.Status != "pending" || !a.ExpiresAt.After(now) {
			return core.ErrInvalidAuthorization
		}
		fields := url.Values{"iss": {s.issuer}}
		if a.StatePresent {
			fields.Set("state", a.State)
		}
		a.UserID = in.Principal.UserID
		a.State = ""
		a.StatePresent = false
		a.RetainUntil = now.Add(24 * time.Hour)
		if in.Decision == "approve" {
			code := secret.Random(core.CodePrefix)
			a.CodeHash = secret.Hash(code)
			expiry := now.Add(5 * time.Minute)
			a.CodeExpiresAt = &expiry
			a.Status = "approved"
			fields.Set("code", code)
		} else {
			a.Status = "denied"
			fields.Set("error", "access_denied")
		}
		result.RedirectURI, err = core.CallbackURI(a.RedirectURI, fields)
		if err != nil {
			return err
		}
		return dao.UpdateAuthorization(ctx, a)
	})
	if c.Outcome != store.TransactionUnknown && errors.Is(e, model.ErrNotFound) {
		return DecisionResult{}, core.ErrInvalidAuthorization
	}
	if err := completionError(c, e); err != nil {
		return DecisionResult{}, err
	}
	return result, nil
}

var errRetryCode = errors.New("retry code after releasing lock")

func (s *Authorizations) RedeemCode(ctx context.Context, in RedeemInput) (TokenResult, error) {
	if !secret.Valid(in.Code, core.CodePrefix) || in.ClientID == "" || in.Resource != s.resource || !core.ValidVerifier(in.Verifier) {
		return TokenResult{}, core.ErrInvalidGrant
	}
	hash := secret.Hash(in.Code)
	// Verify the client against stored bindings before charging its budget.
	// Release the lookup transaction first: charging uses the same connection
	// pool, and holding a connection across that call can exhaust the pool.
	if in.AdmitClient != nil {
		var verified string
		c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			a, err := scope.AuthorizationDAO().AuthorizationByCode(ctx, hash, false)
			if err != nil {
				return err
			}
			if a.ClientID != in.ClientID || a.RedirectURI != in.RedirectURI || a.Resource != in.Resource || a.Scope != core.Scope || !core.VerifyChallenge(a.Challenge, in.Verifier) {
				return core.ErrInvalidGrant
			}
			verified = a.ClientID
			return nil
		})
		if c.Outcome != store.TransactionUnknown && errors.Is(e, model.ErrNotFound) {
			return TokenResult{}, core.ErrInvalidGrant
		}
		if err := completionError(c, e); err != nil {
			return TokenResult{}, err
		}
		if err := in.AdmitClient(ctx, verified); err != nil {
			return TokenResult{}, err
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		var result TokenResult
		var replay bool
		c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			dao := scope.AuthorizationDAO()
			initial, err := dao.AuthorizationByCode(ctx, hash, false)
			if err != nil {
				return err
			}
			if initial.GrantID != "" {
				if _, err = scope.CredentialFamilyDAO().InspectGrant(ctx, initial.GrantID, true); err != nil {
					return err
				}
			}
			a, err := dao.AuthorizationByCode(ctx, hash, true)
			if err != nil {
				return err
			}
			if initial.GrantID == "" && a.GrantID != "" {
				return errRetryCode
			}
			if initial.GrantID != a.GrantID {
				return core.ErrInvalidGrant
			}
			now, err := dao.FreshTime(ctx, s.clock())
			if err != nil {
				return err
			}
			if a.ClientID != in.ClientID || a.RedirectURI != in.RedirectURI || a.Resource != in.Resource || a.Scope != core.Scope || !core.VerifyChallenge(a.Challenge, in.Verifier) {
				return core.ErrInvalidGrant
			}
			if a.Status == "consumed" {
				grant, err := scope.CredentialFamilyDAO().InspectGrant(ctx, a.GrantID, false)
				if err != nil {
					return err
				}
				if !grant.ExpiresAt.After(now) {
					return core.ErrInvalidGrant
				}
				_, err = scope.CredentialFamilyDAO().RevokeFamily(ctx, a.GrantID, now)
				if err != nil {
					return err
				}
				replay = true
				return nil
			}
			if a.Status != "approved" || a.CodeExpiresAt == nil || !a.CodeExpiresAt.After(now) {
				return core.ErrInvalidGrant
			}
			var client core.ValidatedClient
			if json.Unmarshal(a.Client, &client) != nil {
				return core.ErrInvalidGrant
			}
			if client.Provenance == "dcr" {
				if _, err = scope.OAuthClientDAO().PinClient(ctx, a.ClientID, now); err != nil {
					return err
				}
				now, err = dao.FreshTime(ctx, now)
				if err != nil {
					return err
				}
				if !a.CodeExpiresAt.After(now) {
					return core.ErrInvalidGrant
				}
			}
			issued, err := core.IssueFamily(ctx, scope.CredentialFamilyDAO(), core.IssueInput{UserID: a.UserID, ClientID: a.ClientID, Resource: a.Resource, ClientSnapshot: a.Client}, now)
			if err != nil {
				return err
			}
			a.Status = "consumed"
			a.GrantID = issued.Grant.ID
			a.RetainUntil = issued.Grant.ExpiresAt
			if err = dao.UpdateAuthorization(ctx, a); err != nil {
				return err
			}
			result = TokenResult{AccessToken: issued.AccessToken, RefreshToken: issued.RefreshToken, TokenType: "Bearer", Scope: core.Scope, ExpiresIn: int64(core.AccessLifetime / time.Second)}
			return nil
		})
		if errors.Is(e, errRetryCode) && c.Outcome == store.TransactionNotCommitted {
			continue
		}
		if c.Outcome != store.TransactionUnknown && errors.Is(e, model.ErrNotFound) {
			return TokenResult{}, core.ErrInvalidGrant
		}
		if err := completionError(c, e); err != nil {
			return TokenResult{}, err
		}
		if replay {
			return TokenResult{}, core.ErrInvalidGrant
		}
		return result, nil
	}
	return TokenResult{}, core.ErrInvalidGrant
}
func (s *Authorizations) PruneAuthorizations(ctx context.Context, budget int) (int, error) {
	if budget < 0 {
		return 0, fmt.Errorf("invalid authorization cleanup budget")
	}
	budget = min(budget, 2000)
	total := 0
	for budget > 0 {
		batch := min(budget, 100)
		n := 0
		c, e := s.writer.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			var err error
			n, err = scope.AuthorizationDAO().PruneAuthorizations(ctx, s.clock(), batch)
			return err
		})
		if err := completionError(c, e); err != nil {
			return total, err
		}
		total += n
		budget -= n
		if n < batch {
			break
		}
	}
	return total, nil
}
