package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// BrowserSessionPage contains only the caller's current account sessions.
type BrowserSessionPage struct {
	UserID     string
	Current    model.Session
	Items      []model.Session
	NextCursor *string
}

type browserCursor struct {
	Version int       `json:"v"`
	User    string    `json:"u"`
	Session string    `json:"s"`
	Created time.Time `json:"t"`
	ID      string    `json:"i"`
}

func parseBrowserCursor(value string, p model.Principal) (*store.BrowserSessionPosition, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 1024 {
		return nil, invalidInput("Invalid browser session cursor.")
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, invalidInput("Invalid browser session cursor.")
	}
	var c browserCursor
	if err = json.Unmarshal(raw, &c); err != nil || c.Version != 1 || c.User != p.UserID || c.Session != p.CredentialID || c.Created.IsZero() {
		return nil, invalidInput("Invalid browser session cursor.")
	}
	id, err := model.CanonicalID(c.ID)
	if err != nil || id != c.ID {
		return nil, invalidInput("Invalid browser session cursor.")
	}
	return &store.BrowserSessionPosition{CreatedAt: c.Created, ID: id}, nil
}

func validateSessionProjection(s model.Session) error {
	if s.Browser != nil && !validBrowser(*s.Browser) {
		return fmt.Errorf("invalid stored browser classification")
	}
	if s.OS != nil && !validOS(*s.OS) {
		return fmt.Errorf("invalid stored operating system classification")
	}
	return nil
}

func validBrowser(s string) bool {
	switch s {
	case "Chrome", "Edge", "Firefox", "Safari", "Opera":
		return true
	}
	return false
}
func validOS(s string) bool {
	switch s {
	case "Windows", "macOS", "Linux", "Android", "iOS":
		return true
	}
	return false
}

// ClassifyBrowserUserAgent derives bounded labels without retaining the header.
func ClassifyBrowserUserAgent(ua string) (*string, *string) {
	if len(ua) > 4096 {
		return nil, nil
	}
	var browser, os string
	switch {
	case strings.Contains(ua, "Edg/") || strings.Contains(ua, "EdgiOS/") || strings.Contains(ua, "EdgA/"):
		browser = "Edge"
	case strings.Contains(ua, "OPR/") || strings.Contains(ua, "Opera/"):
		browser = "Opera"
	case strings.Contains(ua, "Firefox/") || strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/") || strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/") && strings.Contains(ua, "Version/"):
		browser = "Safari"
	}
	switch {
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad") || strings.Contains(ua, "iPod"):
		os = "iOS"
	case strings.Contains(ua, "Windows NT"):
		os = "Windows"
	case strings.Contains(ua, "Macintosh"):
		os = "macOS"
	case strings.Contains(ua, "Linux"):
		os = "Linux"
	}
	var b, o *string
	if browser != "" {
		b = &browser
	}
	if os != "" {
		o = &os
	}
	return b, o
}

func managementDAO(dao store.IdentityDAO) (store.BrowserSessionManagementDAO, error) {
	result, ok := dao.(store.BrowserSessionManagementDAO)
	if !ok {
		return nil, errors.New("identity scope lacks browser session management capability")
	}
	return result, nil
}

func (s *Identity) ListBrowserSessions(ctx context.Context, dao store.IdentityDAO, p model.Principal, cursor string, limit int) (BrowserSessionPage, error) {
	if err := ValidateSession(p); err != nil {
		return BrowserSessionPage{}, err
	}
	if limit < 1 || limit > 100 {
		return BrowserSessionPage{}, invalidInput("Invalid browser session page size.")
	}
	position, err := parseBrowserCursor(cursor, p)
	if err != nil {
		return BrowserSessionPage{}, err
	}
	d, err := managementDAO(dao)
	if err != nil {
		return BrowserSessionPage{}, err
	}
	now, err := d.SessionTime(ctx)
	if err != nil {
		return BrowserSessionPage{}, err
	}
	current, err := d.ReadBrowserSession(ctx, p.UserID, p.CredentialID, now)
	if err != nil {
		return BrowserSessionPage{}, authLookupError(err)
	}
	if err = validateSessionProjection(current); err != nil {
		return BrowserSessionPage{}, err
	}
	items, err := d.ListBrowserSessions(ctx, p.UserID, p.CredentialID, now, position, limit+1)
	if err != nil {
		return BrowserSessionPage{}, err
	}
	for _, item := range items {
		if err = validateSessionProjection(item); err != nil {
			return BrowserSessionPage{}, err
		}
	}
	result := BrowserSessionPage{UserID: p.UserID, Current: current, Items: items}
	if len(items) > limit {
		result.Items = items[:limit]
		last := result.Items[len(result.Items)-1]
		raw, err := json.Marshal(browserCursor{Version: 1, User: p.UserID, Session: p.CredentialID, Created: last.CreatedAt, ID: last.ID})
		if err != nil {
			return BrowserSessionPage{}, err
		}
		encoded := base64.RawURLEncoding.EncodeToString(raw)
		result.NextCursor = &encoded
	}
	return result, nil
}

func (s *Identity) GetBrowserSession(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string) (model.Session, error) {
	if err := ValidateSession(p); err != nil {
		return model.Session{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return model.Session{}, err
	}
	d, err := managementDAO(dao)
	if err != nil {
		return model.Session{}, err
	}
	now, err := d.SessionTime(ctx)
	if err != nil {
		return model.Session{}, err
	}
	if _, err = d.ReadBrowserSession(ctx, p.UserID, p.CredentialID, now); err != nil {
		return model.Session{}, authLookupError(err)
	}
	result, err := d.ReadBrowserSession(ctx, p.UserID, id, now)
	if errors.Is(err, model.ErrNotFound) {
		return model.Session{}, browserSessionNotFound(err)
	}
	if err != nil {
		return model.Session{}, err
	}
	if err = validateSessionProjection(result); err != nil {
		return model.Session{}, err
	}
	return result, nil
}

func (s *Identity) RevokeBrowserSession(ctx context.Context, dao store.IdentityDAO, p model.Principal, id, expectedUser, expectedSession string) error {
	if err := ValidateSession(p); err != nil {
		return err
	}
	var err error
	id, err = model.CanonicalID(id)
	if err != nil {
		return err
	}
	expectedUser, err = model.CanonicalID(expectedUser)
	if err != nil {
		return err
	}
	expectedSession, err = model.CanonicalID(expectedSession)
	if err != nil {
		return err
	}
	if expectedUser != p.UserID || expectedSession != p.CredentialID {
		return &model.Fault{Code: "identity_mismatch", Message: "The browser account or session changed."}
	}
	d, err := managementDAO(dao)
	if err != nil {
		return err
	}
	ids := []string{p.CredentialID}
	if id != p.CredentialID {
		ids = append(ids, id)
		if ids[1] < ids[0] {
			ids[0], ids[1] = ids[1], ids[0]
		}
	}
	var caller, target model.Session
	var targetMissing bool
	for _, lockID := range ids {
		row, lockErr := d.LockBrowserSessionID(ctx, p.UserID, lockID)
		if errors.Is(lockErr, model.ErrNotFound) {
			if lockID == p.CredentialID {
				return model.Unauthenticated(lockErr)
			}
			targetMissing = true
			continue
		}
		if lockErr != nil {
			return lockErr
		}
		if lockID == p.CredentialID {
			caller = row
		}
		if lockID == id {
			target = row
		}
	}
	now, err := d.SessionTime(ctx)
	if err != nil {
		return err
	}
	if !caller.ExpiresAt.After(now) {
		return model.Unauthenticated(model.ErrNotFound)
	}
	if id == p.CredentialID {
		return &model.Fault{Code: "identity_mismatch", Message: "The current browser session cannot be revoked here."}
	}
	if targetMissing || !target.ExpiresAt.After(now) {
		return browserSessionNotFound(model.ErrNotFound)
	}
	return d.DeleteBrowserSessionID(ctx, p.UserID, id)
}

func browserSessionNotFound(err error) error {
	return &model.Fault{Code: "not_found", Message: "Browser session not found.", Cause: err}
}
