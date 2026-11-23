package github

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type authorCursorJSON struct {
	RepositoryID *string `json:"repositoryId,omitempty"`
	V            int     `json:"v"`
	ProjectID    string  `json:"projectId"`
	Q            string  `json:"q"`
	Limit        int     `json:"limit"`
	Revision     string  `json:"revision"`
	NameKey      string  `json:"nameKey"`
	AuthorID     string  `json:"authorId"`
}
type authorCursor struct {
	revision, authorID int64
	nameKey            string
}

var authorCursorKeys = map[string]bool{"v": true, "projectId": true, "q": true, "limit": true, "revision": true, "nameKey": true, "authorId": true, "repositoryId": true}

func decodeAuthorCursor(encoded, id string, request AuthorsRequest) (*authorCursor, error) {
	bad := func() (*authorCursor, error) { return nil, invalid("Cursor is invalid for this directory.") }
	if len(encoded) > transport.MaxEncodedCursorBytes {
		return bad()
	}
	raw, e := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if e != nil || !jsonunicode.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return bad()
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	tok, e := d.Token()
	if e != nil || tok != json.Delim('{') {
		return bad()
	}
	seen := map[string]bool{}
	for d.More() {
		k, e := d.Token()
		if e != nil {
			return bad()
		}
		key, ok := k.(string)
		if !ok || seen[key] || !authorCursorKeys[key] {
			return bad()
		}
		seen[key] = true
		var v json.RawMessage
		if d.Decode(&v) != nil || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return bad()
		}
	}
	if _, e = d.Token(); e != nil || d.Decode(new(any)) != io.EOF {
		return bad()
	}
	var c authorCursorJSON
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return bad()
	}
	revision, ok := number(c.Revision, true)
	if !ok {
		return bad()
	}
	authorID, ok := number(c.AuthorID, false)
	if !ok {
		return bad()
	}
	expectedFields, expectedVersion := 7, 1
	if request.RepositoryID != nil {
		expectedFields, expectedVersion = 8, 2
		if c.RepositoryID == nil {
			return bad()
		}
		repositoryID, ok := number(*c.RepositoryID, false)
		if !ok || repositoryID != *request.RepositoryID {
			return bad()
		}
	} else if c.RepositoryID != nil {
		return bad()
	}
	if len(seen) != expectedFields || c.V != expectedVersion || c.ProjectID != id || c.Q != request.Query || c.Limit != request.Limit || !utf8.ValidString(c.NameKey) || containsNUL(c.NameKey) {
		return bad()
	}
	return &authorCursor{revision, authorID, c.NameKey}, nil
}
func encodeAuthorCursor(id string, request AuthorsRequest, revision int64, author githubpr.Author) (*string, error) {
	c := authorCursorJSON{V: 1, ProjectID: id, Q: request.Query, Limit: request.Limit, Revision: strconv.FormatInt(revision, 10), NameKey: author.NameKey, AuthorID: strconv.FormatInt(author.ID, 10)}
	if request.RepositoryID != nil {
		c.V = 2
		repositoryID := strconv.FormatInt(*request.RepositoryID, 10)
		c.RepositoryID = &repositoryID
	}
	b, e := json.Marshal(c)
	if e != nil {
		return nil, e
	}
	s := base64.RawURLEncoding.EncodeToString(b)
	if len(s) > transport.MaxEncodedCursorBytes {
		return nil, fmt.Errorf("author directory cursor exceeds size limit")
	}
	return &s, nil
}
