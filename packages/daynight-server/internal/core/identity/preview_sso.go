package identity

import (
	"context"
	"crypto/subtle"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const PreviewCodeLifetime = time.Minute
const previewSecretPrefix = "dnpv_"

type PreviewSSO struct {
	main, preview *url.URL
	identity      *Identity
	callbackPath  string
}

type PreviewSSOStart struct {
	LoginID, State string
	ExpiresAt      time.Time
}

type PreviewSSOAuthorization struct {
	Code      string
	ExpiresAt time.Time
}

type PreviewSSORedemption struct {
	LoginID, Secret string
	ExpiresAt       time.Time
}

// NewPreviewSSO fixes the only origins and callback to which a login may return.
func NewPreviewSSO(mainOrigin, previewOrigin, callbackURL string) (*PreviewSSO, error) {
	parseOrigin := func(value string) (*url.URL, error) {
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || value != u.Scheme+"://"+u.Host || strings.ToLower(u.Host) != u.Host {
			return nil, invalidInput("Invalid SSO origin.")
		}
		return u, nil
	}
	main, err := parseOrigin(mainOrigin)
	if err != nil {
		return nil, err
	}
	preview, err := parseOrigin(previewOrigin)
	if err != nil {
		return nil, err
	}
	callback, err := url.Parse(callbackURL)
	if err != nil || callback.Scheme != main.Scheme || callback.Host != main.Host || callback.User != nil || callback.Opaque != "" || callback.Path == "" || callback.RawQuery != "" || callback.ForceQuery || callback.Fragment != "" || callbackURL != mainOrigin+callback.EscapedPath() {
		return nil, invalidInput("Invalid main-site callback URL.")
	}
	return &PreviewSSO{main: main, preview: preview, identity: NewIdentity(callbackURL), callbackPath: callback.EscapedPath()}, nil
}

func canonicalUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

// ValidateReturnURL checks the original target without rewriting its escaped path or query.
func (s *PreviewSSO) ValidateReturnURL(value string) error {
	invalid := func() error { return invalidInput("Invalid preview SSO return URL.") }
	if !utf8.ValidString(value) || strings.ContainsAny(value, "\\#") || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return invalid()
	}
	u, err := url.Parse(value)
	if err != nil || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.Host == "" || u.Scheme == "" || u.Path == "" || !strings.HasPrefix(u.EscapedPath(), "/") {
		return invalid()
	}
	target := u.EscapedPath()
	if u.ForceQuery || u.RawQuery != "" {
		target += "?" + u.RawQuery
	}
	if len(u.RawQuery) > transport.MaxRawQueryBytes || len(target) > transport.MaxRequestTargetBytes {
		return invalid()
	}
	if u.Scheme == s.main.Scheme && u.Host == s.main.Host {
		if u.EscapedPath() == "/auth/complete" {
			q, err := url.ParseQuery(u.RawQuery)
			if err != nil || len(q) != 2 || len(q["returnPath"]) != 1 || len(q["callbackPath"]) != 1 || q.Get("callbackPath") != s.callbackPath || AdmitReturnPath(q.Get("returnPath")) != nil || !s.identity.validReturnPath(q.Get("returnPath")) {
				return invalid()
			}
			return nil
		}
		// Check browser-resolved and decoded forms through the existing login policy.
		if !s.identity.validReturnPath(target) {
			return invalid()
		}
		browser, err := url.PathUnescape(browserReturnPath(u.EscapedPath()))
		if err != nil {
			return invalid()
		}
		browser, err = url.PathUnescape(browser)
		browser = path.Clean(browser)
		if err != nil || strings.IndexFunc(browser, unicode.IsControl) >= 0 || browser == "/auth/sso" || strings.HasPrefix(browser, "/auth/sso/") {
			return invalid()
		}
		return nil
	}
	if u.Scheme != s.preview.Scheme || u.Port() != s.preview.Port() {
		return invalid()
	}
	suffix := "." + s.preview.Hostname()
	host := u.Hostname()
	if !strings.HasSuffix(host, suffix) || !canonicalUUID(strings.TrimSuffix(host, suffix)) || u.Host != host+portSuffix(s.preview) {
		return invalid()
	}
	segments := strings.Split(u.EscapedPath(), "/")
	if len(segments) < 9 || segments[0] != "" {
		return invalid()
	}
	decoded := make([]string, len(segments))
	for i, segment := range segments {
		decoded[i], err = url.PathUnescape(segment)
		if err != nil || strings.Contains(decoded[i], "/") {
			return invalid()
		}
	}
	if decoded[1] != "api" || decoded[2] != "v1" || decoded[3] != "projects" || !canonicalUUID(decoded[4]) || decoded[5] != "tasks" || decoded[6] != strings.TrimSuffix(host, suffix) || decoded[7] != "preview" || filestorage.ValidateAddress("task-attachments", strings.Join(decoded[1:], "/")) != nil || filestorage.ValidateAddress("task-attachments", strings.Join(decoded[8:], "/")) != nil {
		return invalid()
	}
	return nil
}

func portSuffix(u *url.URL) string {
	if u.Port() == "" {
		return ""
	}
	return ":" + u.Port()
}

func (s *PreviewSSO) Create(ctx context.Context, dao store.PreviewSSODAO, returnURL string, now time.Time) (model.PreviewSSOLogin, error) {
	if err := s.ValidateReturnURL(returnURL); err != nil {
		return model.PreviewSSOLogin{}, err
	}
	started := time.Now()
	if err := dao.CleanupPreviewSSO(ctx, now); err != nil {
		return model.PreviewSSOLogin{}, err
	}
	login := model.PreviewSSOLogin{ID: uuid.NewString(), ReturnURL: returnURL, ExpiresAt: now.Add(time.Since(started)).Add(LoginLifetime)}
	if err := dao.InsertPreviewSSO(ctx, login); err != nil {
		return model.PreviewSSOLogin{}, err
	}
	return login, nil
}

func (s *PreviewSSO) Start(ctx context.Context, dao store.PreviewSSODAO, id string, now time.Time) (PreviewSSOStart, error) {
	if !canonicalUUID(id) {
		return PreviewSSOStart{}, model.Unauthenticated(nil)
	}
	state := secret.Random("")
	login, err := dao.StartPreviewSSO(ctx, id, secret.Hash(state), now)
	if err != nil {
		return PreviewSSOStart{}, authLookupError(err)
	}
	if err := s.ValidateReturnURL(login.ReturnURL); err != nil {
		return PreviewSSOStart{}, err
	}
	return PreviewSSOStart{LoginID: login.ID, State: state, ExpiresAt: login.ExpiresAt}, nil
}

func (s *PreviewSSO) Authorize(ctx context.Context, dao store.PreviewSSODAO, id, state string, principal model.Principal, now time.Time) (PreviewSSOAuthorization, error) {
	if !canonicalUUID(id) || !secret.Valid(state, "") {
		return PreviewSSOAuthorization{}, model.Unauthenticated(nil)
	}
	if err := ValidateSession(principal); err != nil {
		return PreviewSSOAuthorization{}, err
	}
	started := time.Now()
	if err := dao.CleanupPreviewSSO(ctx, now); err != nil {
		return PreviewSSOAuthorization{}, err
	}
	issuedAt, err := dao.LockPreviewAuthorization(ctx, id, secret.Hash(state), principal, now.Add(time.Since(started)))
	if err != nil {
		return PreviewSSOAuthorization{}, authLookupError(err)
	}
	code := secret.Random("")
	expires := issuedAt.Add(PreviewCodeLifetime)
	if err := dao.SetPreviewAuthorization(ctx, id, principal, secret.Hash(code), expires); err != nil {
		return PreviewSSOAuthorization{}, authLookupError(err)
	}
	return PreviewSSOAuthorization{Code: code, ExpiresAt: expires}, nil
}

func (s *PreviewSSO) Redeem(ctx context.Context, dao store.PreviewSSODAO, code, state, binding string, now time.Time) (PreviewSSORedemption, error) {
	if !secret.Valid(code, "") || !secret.Valid(state, "") || !secret.Valid(binding, "") || subtle.ConstantTimeCompare([]byte(state), []byte(binding)) != 1 {
		return PreviewSSORedemption{}, model.Unauthenticated(nil)
	}
	value := secret.Random(previewSecretPrefix)
	login, session, err := dao.RedeemPreviewSSO(ctx, secret.Hash(code), secret.Hash(state), secret.Hash(value), now)
	if err != nil {
		return PreviewSSORedemption{}, authLookupError(err)
	}
	if err := s.ValidateReturnURL(login.ReturnURL); err != nil {
		return PreviewSSORedemption{}, err
	}
	return PreviewSSORedemption{LoginID: login.ID, Secret: value, ExpiresAt: session.ExpiresAt}, nil
}

func (s *PreviewSSO) Complete(ctx context.Context, dao store.PreviewSSODAO, id, value string, now time.Time) (string, error) {
	if !canonicalUUID(id) || !secret.Valid(value, previewSecretPrefix) {
		return "", model.Unauthenticated(nil)
	}
	login, err := dao.CompletePreviewSSO(ctx, id, secret.Hash(value), now)
	if err != nil {
		return "", authLookupError(err)
	}
	if err := s.ValidateReturnURL(login.ReturnURL); err != nil {
		return "", err
	}
	return login.ReturnURL, nil
}

func (s *PreviewSSO) Authenticate(ctx context.Context, dao store.PreviewSSODAO, value string, now time.Time) (model.Principal, time.Time, error) {
	if !secret.Valid(value, previewSecretPrefix) {
		return model.Principal{}, time.Time{}, model.Unauthenticated(nil)
	}
	p, expires, err := dao.AuthenticatePreview(ctx, secret.Hash(value), now)
	return p, expires, authLookupError(err)
}
