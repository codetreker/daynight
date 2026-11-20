package github

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type repositoryCursorJSON struct {
	V                 int    `json:"v"`
	ProjectID         string `json:"projectId"`
	AfterRepositoryID string `json:"afterRepositoryId"`
}

func encodeRepositoryCursor(projectID string, repositoryID int64) *string {
	raw, _ := json.Marshal(repositoryCursorJSON{1, projectID, strconv.FormatInt(repositoryID, 10)})
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	return &encoded
}

func decodeRepositoryCursor(encoded, projectID string) (*int64, error) {
	bad := func() (*int64, error) { return nil, invalid("Cursor is invalid for this repository directory.") }
	if len(encoded) > transport.MaxEncodedCursorBytes {
		return bad()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || !jsonunicode.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return bad()
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return bad()
	}
	seen := map[string]bool{}
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return bad()
		}
		key, ok := token.(string)
		if !ok || seen[key] || (key != "v" && key != "projectId" && key != "afterRepositoryId") {
			return bad()
		}
		seen[key] = true
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return bad()
		}
	}
	if _, err = d.Token(); err != nil || d.Decode(new(any)) != io.EOF || len(seen) != 3 {
		return bad()
	}
	var cursor repositoryCursorJSON
	if json.Unmarshal(raw, &cursor) != nil || cursor.V != 1 || cursor.ProjectID != projectID {
		return bad()
	}
	anchor, ok := number(cursor.AfterRepositoryID, false)
	if !ok {
		return bad()
	}
	return &anchor, nil
}
