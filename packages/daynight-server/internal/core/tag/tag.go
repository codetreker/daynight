package tag

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func Fault(code, message string, cause error) error {
	return &model.Fault{Code: code, Message: message, Cause: cause}
}

// Name preserves presentation spelling while giving every writer one comparison key.
func Name(value string) (string, string, error) {
	if !utf8.ValidString(value) {
		return "", "", Fault("invalid_tag_name", "Tag name must be valid UTF-8.", nil)
	}
	value = strings.TrimFunc(value, unicode.IsSpace)
	if n := utf8.RuneCountInString(value); n < 1 || n > 64 {
		return "", "", Fault("invalid_tag_name", "Tag name must contain 1 to 64 characters.", nil)
	}
	for _, r := range value {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return "", "", Fault("invalid_tag_name", "Tag name contains a prohibited character.", nil)
		}
	}
	return value, Fold(value), nil
}

func Fold(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, value)
}

func Version(version int64) error {
	if version < 1 {
		return Fault("invalid_input", "Version must be positive.", nil)
	}
	return nil
}
func CheckVersion(item model.Tag, version int64) error {
	if item.Version != version {
		return Fault("version_conflict", "Tag version does not match.", nil)
	}
	return nil
}
func Lookup(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return Fault("tag_not_found", "Tag was not found.", err)
	}
	if errors.Is(err, store.ErrTagWriteConflict) {
		return Fault("version_conflict", "Tag version does not match.", err)
	}
	return err
}
func Unique(err error) error {
	if errors.Is(err, store.ErrTagNameConflict) {
		return Fault("tag_name_conflict", "A tag with this name already exists.", err)
	}
	return err
}

type Cursor struct {
	Version      int                  `json:"v"`
	ProjectID    string               `json:"p"`
	UserID       string               `json:"u"`
	CredentialID string               `json:"c"`
	Kind         model.CredentialKind `json:"k"`
	Query        string               `json:"q"`
	Limit        int                  `json:"l"`
	Epoch        string               `json:"e"`
	NameKey      string               `json:"n"`
	ID           string               `json:"i"`
}

func EncodeCursor(cursor Cursor) (string, error) {
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
func DecodeCursor(raw string, expected Cursor) (*store.TagPosition, error) {
	invalid := func() (*store.TagPosition, error) {
		return nil, Fault("catalog_changed", "Tag catalog cursor is invalid or changed; restart the list.", nil)
	}
	if len(raw) > 16*1024 {
		return invalid()
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return invalid()
	}
	var got Cursor
	if json.Unmarshal(b, &got) != nil || got.Version != 1 || got.ProjectID != expected.ProjectID || got.UserID != expected.UserID || got.CredentialID != expected.CredentialID || got.Kind != expected.Kind || got.Query != expected.Query || got.Limit != expected.Limit || got.Epoch != expected.Epoch {
		return invalid()
	}
	id, err := model.CanonicalID(got.ID)
	if err != nil || id != got.ID || got.NameKey == "" || !utf8.ValidString(got.NameKey) {
		return invalid()
	}
	return &store.TagPosition{NameKey: got.NameKey, ID: got.ID}, nil
}
