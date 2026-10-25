package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/google/uuid"
)

const SessionLifetime = 7 * 24 * time.Hour
const LoginLifetime = 10 * time.Minute

// Identity owns product credentials; the gateway only supplies one-time identities.
type Identity struct {
	store       *store.Store
	client      *uniauth.Client
	callbackURL string
	now         func() time.Time
}

func NewIdentity(database *store.Store, client *uniauth.Client, callbackURL string) *Identity {
	return &Identity{store: database, client: client, callbackURL: callbackURL, now: time.Now}
}

func (s *Identity) CallbackURL() string { return s.callbackURL }

type LoginStart struct {
	ID               string
	State            string
	BrowserBinding   string
	AuthorizationURL string
	ExpiresAt        time.Time
}

type LoginCompletion struct {
	LoginID    string
	User       core.User
	Session    core.Session
	Secret     string
	ReturnPath string
}

func randomSecret(prefix string) string {
	bytes := make([]byte, 32)
	_, _ = rand.Read(bytes)
	return prefix + base64.RawURLEncoding.EncodeToString(bytes)
}

func secretHash(secret string) []byte {
	hash := sha256.Sum256([]byte(secret))
	return hash[:]
}

func validSecret(secret, prefix string) bool {
	if !strings.HasPrefix(secret, prefix) {
		return false
	}
	raw := strings.TrimPrefix(secret, prefix)
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == raw
}

func (s *Identity) validReturnPath(value string) bool {
	if !utf8.ValidString(value) || strings.ContainsAny(value, "\\\r\n\x00") {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") {
		return false
	}
	decoded, err := url.PathUnescape(u.Path)
	if err != nil || strings.ContainsAny(decoded, "\\\r\n\x00") || strings.HasPrefix(decoded, "//") || strings.HasPrefix(path.Clean(decoded), "/api/v1/auth") {
		return false
	}
	callback, err := url.Parse(s.callbackURL)
	if err != nil {
		return false
	}
	target := path.Clean(decoded)
	return target != callback.Path && !strings.HasPrefix(target, callback.Path+"/")
}

func (s *Identity) StartLogin(ctx context.Context, provider, returnPath string) (LoginStart, error) {
	if provider != "microsoft" && provider != "google" && provider != "github" {
		return LoginStart{}, invalidInput("Provider must be microsoft, google, or github.")
	}
	if returnPath == "" {
		returnPath = "/"
	}
	if !s.validReturnPath(returnPath) {
		return LoginStart{}, invalidInput("Return path must be a main-site path outside authentication routes.")
	}
	start := LoginStart{ID: uuid.NewString(), State: randomSecret(""), BrowserBinding: randomSecret(""), ExpiresAt: s.now().UTC().Add(LoginLifetime)}
	var err error
	start.AuthorizationURL, err = s.client.AuthorizationURL(uniauth.AuthorizationRequest{Provider: uniauth.Provider(provider), RedirectURI: s.callbackURL, State: start.State})
	if err != nil {
		return LoginStart{}, err
	}
	err = s.store.CreateLogin(ctx, core.LoginTransaction{ID: start.ID, StateHash: secretHash(start.State), BrowserBindingHash: secretHash(start.BrowserBinding), Provider: provider, ReturnPath: returnPath, ExpiresAt: start.ExpiresAt}, s.now().UTC())
	if err != nil {
		return LoginStart{}, err
	}
	return start, nil
}

func unauthenticated(cause error) error {
	return &Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again.", Cause: cause}
}
func forbidden() error {
	return &Fault{Code: "forbidden", Message: "A main-site browser session is required for this operation."}
}

func (s *Identity) CompleteLogin(ctx context.Context, query url.Values, binding string) (LoginCompletion, error) {
	if len(query["state"]) != 1 || !validSecret(query.Get("state"), "") || !validSecret(binding, "") {
		return LoginCompletion{}, unauthenticated(nil)
	}
	state := query.Get("state")
	code, callbackErr := uniauth.ParseCallback(query, state)
	if callbackErr != nil {
		var failure *uniauth.CallbackError
		if !errors.As(callbackErr, &failure) || failure.Code == "invalid_callback" || failure.Code == "state_mismatch" {
			return LoginCompletion{}, unauthenticated(callbackErr)
		}
	}
	pending, err := s.store.ConsumeLogin(ctx, secretHash(state), secretHash(binding), s.now().UTC())
	if err != nil {
		return LoginCompletion{}, authLookupError(err)
	}
	result := LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath}
	if callbackErr != nil {
		return result, unauthenticated(callbackErr)
	}
	claimCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	identity, err := s.client.Retrieve(claimCtx, code)
	if err != nil {
		return result, err
	}
	if string(identity.Provider) != pending.Provider {
		return result, unauthenticated(&uniauth.ProtocolError{Reason: "provider_mismatch"})
	}
	now := s.now().UTC()
	result.Secret = randomSecret("dnst_")
	result.Session = core.Session{ID: uuid.NewString(), TokenHash: secretHash(result.Secret), CreatedAt: now, ExpiresAt: now.Add(SessionLifetime)}
	result.User, err = s.store.CreateIdentitySession(ctx, core.User{ID: uuid.NewString(), UniAuthID: identity.ID, Email: identity.Email, EmailVerified: identity.EmailVerified, Name: identity.Name, AvatarURL: identity.AvatarURL}, result.Session)
	if err != nil {
		return LoginCompletion{LoginID: pending.ID}, err
	}
	result.Session.UserID = result.User.ID
	return result, nil
}

func authLookupError(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return unauthenticated(err)
	}
	return err
}

func (s *Identity) Authenticate(ctx context.Context, kind core.CredentialKind, secret string) (core.Principal, error) {
	prefix := "dnst_"
	if kind == core.PATCredential {
		prefix = "dnpat_"
	}
	if !validSecret(secret, prefix) {
		return core.Principal{}, unauthenticated(nil)
	}
	principal, err := s.store.Authenticate(ctx, kind, secretHash(secret), s.now().UTC())
	return principal, authLookupError(err)
}

func (s *Identity) User(ctx context.Context, principal core.Principal) (core.User, error) {
	user, err := s.store.IdentityUser(ctx, principal.UserID)
	return user, authLookupError(err)
}

func (s *Identity) Logout(ctx context.Context, principal core.Principal) error {
	if principal.Kind != core.SessionCredential {
		return forbidden()
	}
	return s.store.DeleteSession(ctx, principal)
}

type MintedPAT struct {
	Credential core.PersonalAccessToken
	Secret     string
}

type CreatePAT struct {
	Name      string
	ExpiresAt *time.Time
}

func (s *Identity) CreatePAT(ctx context.Context, principal core.Principal, input CreatePAT) (MintedPAT, error) {
	if principal.Kind != core.SessionCredential {
		return MintedPAT{}, forbidden()
	}
	if !utf8.ValidString(input.Name) || strings.ContainsRune(input.Name, 0) || strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > 100 {
		return MintedPAT{}, invalidInput("Token name must contain 1 to 100 UTF-8 characters without NUL.")
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	expiresAt, err := validatedTokenExpiry(input.ExpiresAt, now)
	if err != nil {
		return MintedPAT{}, err
	}
	result := MintedPAT{Secret: randomSecret("dnpat_")}
	result.Credential = core.PersonalAccessToken{ID: uuid.NewString(), UserID: principal.UserID, Name: input.Name, TokenHash: secretHash(result.Secret), CreatedAt: now, ExpiresAt: expiresAt}
	if err := s.store.CreatePAT(ctx, principal, result.Credential); err != nil {
		return MintedPAT{}, authLookupError(err)
	}
	return result, nil
}

func (s *Identity) ListPATs(ctx context.Context, principal core.Principal) ([]core.PersonalAccessToken, error) {
	if principal.Kind != core.SessionCredential {
		return nil, forbidden()
	}
	credentials, err := s.store.ListPATs(ctx, principal, s.now().UTC())
	return credentials, authLookupError(err)
}

func (s *Identity) RevokePAT(ctx context.Context, principal core.Principal, id string) error {
	if principal.Kind != core.SessionCredential {
		return forbidden()
	}
	id, err := CanonicalID(id)
	if err != nil {
		return err
	}
	return authLookupError(s.store.RevokePAT(ctx, principal, id, s.now().UTC()))
}

// IdentityProviderError separates backend integration failures from an expired
// product credential while retaining the SDK or context cause.
type IdentityProviderError struct {
	Code  string
	Cause error
}

func (e *IdentityProviderError) Error() string {
	switch e.Code {
	case "identity_configuration":
		return "The identity provider configuration is unavailable."
	case "identity_timeout":
		return "The identity provider request timed out."
	default:
		return "The identity provider is unavailable."
	}
}
func (e *IdentityProviderError) Unwrap() error { return e.Cause }

func (s *Identity) Providers(ctx context.Context) ([]string, error) {
	discovery, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	providers, err := s.client.Providers(discovery, s.callbackURL)
	if err != nil {
		code := "identity_unavailable"
		var upstream *uniauth.APIError
		if errors.As(err, &upstream) && (upstream.StatusCode == 400 || upstream.StatusCode == 401) {
			code = "identity_configuration"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			code = "identity_timeout"
		}
		return nil, &IdentityProviderError{Code: code, Cause: err}
	}
	result := make([]string, 0, len(providers))
	for _, provider := range providers {
		result = append(result, string(provider))
	}
	return result, nil
}
