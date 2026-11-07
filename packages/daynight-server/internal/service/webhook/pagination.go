package webhook

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type ListInput struct {
	Search  string
	Enabled *bool
	Limit   int
	Cursor  *string
}

type cursorScope struct {
	PrincipalID string             `json:"principalId"`
	Owner       webhookmodel.Owner `json:"owner"`
	Search      string             `json:"search"`
	Enabled     *bool              `json:"enabled"`
	CanManage   bool               `json:"canManage"`
}

type endpointCursor struct {
	Version int    `json:"version"`
	Kind    string `json:"kind"`
	cursorScope
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

func normalizeList(input ListInput) (ListInput, error) {
	input.Search = strings.TrimSpace(input.Search)
	if input.Limit < 1 || input.Limit > 100 || !utf8.ValidString(input.Search) || utf8.RuneCountInString(input.Search) > 200 {
		return ListInput{}, &model.Fault{Code: "invalid_input", Message: "Endpoint list limits or search text are invalid."}
	}
	for _, character := range input.Search {
		if unicode.IsControl(character) {
			return ListInput{}, &model.Fault{Code: "invalid_input", Message: "Endpoint search text cannot contain control characters."}
		}
	}
	if input.Cursor != nil && *input.Cursor == "" {
		return ListInput{}, invalidCursor()
	}
	return input, nil
}

func pageFor(input ListInput, scope cursorScope) (store.Page, error) {
	page := store.Page{Limit: input.Limit}
	if input.Cursor == nil {
		return page, nil
	}
	if len(*input.Cursor) > 4096 {
		return store.Page{}, invalidCursor()
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(*input.Cursor)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != *input.Cursor || !jsonunicode.Valid(data) {
		return store.Page{}, invalidCursor()
	}
	fields, err := jsonobject.Decode(data, "endpoint cursor", "version", "kind", "principalId", "owner", "search", "enabled", "canManage", "createdAt", "id")
	if err != nil || len(fields) != 9 {
		return store.Page{}, invalidCursor()
	}
	for _, key := range []string{"version", "kind", "principalId", "owner", "search", "canManage", "createdAt", "id"} {
		if bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
			return store.Page{}, invalidCursor()
		}
	}
	owner, err := jsonobject.Decode(fields["owner"], "cursor owner", "kind", "id")
	if err != nil || len(owner) != 2 {
		return store.Page{}, invalidCursor()
	}
	var cursor endpointCursor
	if err := json.Unmarshal(data, &cursor); err != nil {
		return store.Page{}, invalidCursor()
	}
	id, err := model.CanonicalID(cursor.ID)
	if err != nil || id != cursor.ID || cursor.CreatedAt.IsZero() || cursor.CreatedAt.Location() != time.UTC || cursor.Version != 1 || cursor.Kind != "webhook-endpoints" ||
		cursor.PrincipalID != scope.PrincipalID || cursor.Owner != scope.Owner || cursor.Search != scope.Search || !model.EqualOptional(cursor.Enabled, scope.Enabled) || cursor.CanManage != scope.CanManage {
		return store.Page{}, invalidCursor()
	}
	page.After = &store.Position{CreatedAt: cursor.CreatedAt, ID: cursor.ID}
	return page, nil
}

func nextCursor(scope cursorScope, endpoint webhookmodel.Endpoint) (string, error) {
	data, err := json.Marshal(endpointCursor{Version: 1, Kind: "webhook-endpoints", cursorScope: scope, CreatedAt: endpoint.CreatedAt.UTC(), ID: endpoint.ID})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func invalidCursor() error {
	return &model.Fault{Code: "invalid_input", Message: "Cursor is invalid for this endpoint list."}
}
