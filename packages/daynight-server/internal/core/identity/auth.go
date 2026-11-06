package identity

import (
	"context"
	"errors"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const SessionLifetime = 7 * 24 * time.Hour
const LoginLifetime = 10 * time.Minute

type Identity struct{ callbackURL string }

func NewIdentity(callbackURL string) *Identity { return &Identity{callbackURL: callbackURL} }
func (s *Identity) CallbackURL() string        { return s.callbackURL }

type LoginStart struct {
	ID, State, BrowserBinding, AuthorizationURL string
	ExpiresAt                                   time.Time
}
type LoginCompletion struct {
	LoginID            string
	User               model.User
	Session            model.Session
	Secret, ReturnPath string
}
type MintedPAT struct {
	Credential model.PersonalAccessToken
	Secret     string
}
type CreatePAT struct {
	Name      string
	ExpiresAt *time.Time
}

func invalidInput(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func forbidden() error {
	return &model.Fault{Code: "forbidden", Message: "A main-site browser session is required for this operation."}
}
func authLookupError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	return err
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
	return target != "/login" && !strings.HasPrefix(target, "/login/") && target != callback.Path && !strings.HasPrefix(target, callback.Path+"/")
}

// StartLogin prepares the one-time material before the upstream authorization
// URL is constructed. The caller persists it in a separate transaction.
func (s *Identity) StartLogin(provider, returnPath string, now time.Time) (LoginStart, model.LoginTransaction, error) {
	if provider != "microsoft" && provider != "google" && provider != "github" {
		return LoginStart{}, model.LoginTransaction{}, invalidInput("Provider must be microsoft, google, or github.")
	}
	if returnPath == "" {
		returnPath = "/projects"
	}
	if !s.validReturnPath(returnPath) {
		return LoginStart{}, model.LoginTransaction{}, invalidInput("Return path must be a main-site path outside authentication routes.")
	}
	start := LoginStart{ID: uuid.NewString(), State: secret.Random(""), BrowserBinding: secret.Random(""), ExpiresAt: now.Add(LoginLifetime)}
	pending := model.LoginTransaction{ID: start.ID, StateHash: secret.Hash(start.State), BrowserBindingHash: secret.Hash(start.BrowserBinding), Provider: provider, ReturnPath: returnPath, ExpiresAt: start.ExpiresAt}
	return start, pending, nil
}
func (s *Identity) CreateLogin(ctx context.Context, dao store.IdentityDAO, pending model.LoginTransaction, now time.Time) error {
	if err := dao.CleanupCredentials(ctx, now); err != nil {
		return err
	}
	return dao.InsertLogin(ctx, pending)
}
func ValidateCallback(query url.Values, binding string) error {
	if len(query["state"]) != 1 || !secret.Valid(query.Get("state"), "") || !secret.Valid(binding, "") {
		return model.Unauthenticated(nil)
	}
	return nil
}
func (s *Identity) ConsumeLogin(ctx context.Context, dao store.IdentityDAO, state, binding string, now time.Time) (model.LoginTransaction, error) {
	p, err := dao.ConsumeLogin(ctx, secret.Hash(state), secret.Hash(binding), now)
	return p, authLookupError(err)
}
func CallbackFailure(err error) error { return model.Unauthenticated(err) }
func ValidateProvider(expected, actual string, mismatch error) error {
	if expected != actual {
		return model.Unauthenticated(mismatch)
	}
	return nil
}

// CompleteLogin upserts the claimed user; the caller initializes the team and
// inserts the session with the same scope before committing.
func (s *Identity) CompleteLogin(ctx context.Context, dao store.IdentityDAO, user model.User, now time.Time) (model.User, error) {
	if user.ID == "" {
		user.ID = uuid.NewString()
	}
	return dao.UpsertUser(ctx, user, now)
}
func (s *Identity) NewSession(now time.Time) (model.Session, string) {
	value := secret.Random("dnst_")
	return model.Session{ID: uuid.NewString(), TokenHash: secret.Hash(value), CreatedAt: now, ExpiresAt: now.Add(SessionLifetime)}, value
}
func (s *Identity) CreateSession(ctx context.Context, dao store.IdentityDAO, session model.Session) error {
	return dao.InsertSession(ctx, session)
}
func ValidateCredential(kind model.CredentialKind, value string) error {
	prefix := "dnst_"
	if kind == model.PATCredential {
		prefix = "dnpat_"
	}
	if !secret.Valid(value, prefix) {
		return model.Unauthenticated(nil)
	}
	return nil
}
func (s *Identity) Authenticate(ctx context.Context, dao store.IdentityDAO, kind model.CredentialKind, value string, now time.Time) (model.Principal, error) {
	if err := ValidateCredential(kind, value); err != nil {
		return model.Principal{}, err
	}
	p, err := dao.Authenticate(ctx, kind, secret.Hash(value), now)
	return p, authLookupError(err)
}
func (s *Identity) User(ctx context.Context, dao store.IdentityDAO, p model.Principal) (model.User, store.PersonalTeamFacts, error) {
	u, facts, err := dao.IdentityUser(ctx, p.UserID)
	return u, facts, authLookupError(err)
}
func ValidateSession(p model.Principal) error {
	if p.Kind != model.SessionCredential {
		return forbidden()
	}
	return nil
}
func (s *Identity) Logout(ctx context.Context, dao store.IdentityDAO, p model.Principal) error {
	if err := ValidateSession(p); err != nil {
		return err
	}
	return dao.DeleteSession(ctx, p)
}
func ValidateCreatePAT(p model.Principal, input CreatePAT, now time.Time) (*time.Time, error) {
	if err := ValidateSession(p); err != nil {
		return nil, err
	}
	if !utf8.ValidString(input.Name) || strings.ContainsRune(input.Name, 0) || strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > 100 {
		return nil, invalidInput("Token name must contain 1 to 100 UTF-8 characters without NUL.")
	}
	return validatedTokenExpiry(input.ExpiresAt, now.Truncate(time.Microsecond))
}
func (s *Identity) CreatePAT(ctx context.Context, dao store.IdentityDAO, p model.Principal, input CreatePAT, now time.Time) (MintedPAT, error) {
	now = now.Truncate(time.Microsecond)
	expiry, err := ValidateCreatePAT(p, input, now)
	if err != nil {
		return MintedPAT{}, err
	}
	result := MintedPAT{Secret: secret.Random("dnpat_")}
	result.Credential = model.PersonalAccessToken{ID: uuid.NewString(), UserID: p.UserID, Name: input.Name, TokenHash: secret.Hash(result.Secret), CreatedAt: now, ExpiresAt: expiry}
	if err = s.StorePAT(ctx, dao, p, result.Credential); err != nil {
		return MintedPAT{}, err
	}
	return result, nil
}
func (s *Identity) StorePAT(ctx context.Context, dao store.IdentityDAO, p model.Principal, credential model.PersonalAccessToken) error {
	if err := dao.LockSession(ctx, p, credential.CreatedAt); err != nil {
		return authLookupError(err)
	}
	if err := dao.CleanupCredentials(ctx, credential.CreatedAt); err != nil {
		return err
	}
	credential.UserID = p.UserID
	return dao.InsertPAT(ctx, credential)
}
func (s *Identity) ListPATs(ctx context.Context, dao store.IdentityDAO, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
	if err := ValidateSession(p); err != nil {
		return nil, err
	}
	if err := dao.LockSession(ctx, p, now); err != nil {
		return nil, authLookupError(err)
	}
	return dao.ListPATs(ctx, p.UserID, now)
}
func ValidateRevokePAT(p model.Principal, id string) (string, error) {
	if err := ValidateSession(p); err != nil {
		return "", err
	}
	return model.CanonicalID(id)
}
func (s *Identity) RevokePAT(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string, now time.Time) error {
	id, err := ValidateRevokePAT(p, id)
	if err != nil {
		return err
	}
	if err = dao.LockSession(ctx, p, now); err != nil {
		return authLookupError(err)
	}
	return dao.DeletePAT(ctx, p.UserID, id)
}

// Providers maps discovery failures without depending on an upstream SDK.
func (s *Identity) Providers(providers []string, code string, cause error) ([]string, error) {
	if cause != nil {
		return nil, &model.IdentityProviderError{Code: code, Cause: cause}
	}
	return providers, nil
}
