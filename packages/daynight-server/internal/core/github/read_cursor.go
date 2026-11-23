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

type cursorJSON struct {
	RepositoryID *string `json:"repositoryId,omitempty"`
	V            int     `json:"v"`
	ProjectID    string  `json:"projectId"`
	State        string  `json:"state"`
	Q            string  `json:"q"`
	Limit        int     `json:"limit"`
	UpperNumber  string  `json:"upperNumber"`
	AnchorNumber string  `json:"anchorNumber"`
	Direction    string  `json:"direction"`
	AuthorID     *string `json:"authorId,omitempty"`
}

var cursorKeys = map[string]bool{"v": true, "projectId": true, "state": true, "q": true, "limit": true, "upperNumber": true, "anchorNumber": true, "direction": true, "authorId": true, "repositoryId": true}

type pageCursor struct {
	upper, anchor int64
	direction     string
}

func number(s string, allowZero bool) (int64, bool) {
	n, e := strconv.ParseInt(s, 10, 64)
	return n, e == nil && (n > 0 || allowZero && n == 0) && strconv.FormatInt(n, 10) == s
}
func decodeCursor(encoded, id string, r ListRequest) (*pageCursor, error) {
	bad := func() (*pageCursor, error) { return nil, invalid("Cursor is invalid for this list.") }
	if len(encoded) > transport.MaxEncodedCursorBytes {
		return bad()
	}
	raw, e := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if e != nil || !jsonunicode.Valid(raw) || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return bad()
	}
	// Detect duplicate keys as well as missing and unknown fields.
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
		if !ok || seen[key] || !cursorKeys[key] {
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
	var c cursorJSON
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return bad()
	}
	upper, ok := number(c.UpperNumber, false)
	if !ok {
		return bad()
	}
	anchor, ok := number(c.AnchorNumber, c.Direction == "previous")
	if !ok {
		return bad()
	}
	expectedFields := 8
	expectedVersion := 1
	if r.AuthorID != nil {
		expectedFields++
		expectedVersion = 2
		if c.AuthorID == nil {
			return bad()
		}
		authorID, ok := number(*c.AuthorID, false)
		if !ok || authorID != *r.AuthorID {
			return bad()
		}
	} else if c.AuthorID != nil {
		return bad()
	}
	if r.RepositoryID != nil {
		expectedFields++
		expectedVersion = 3
		if c.RepositoryID == nil {
			return bad()
		}
		repositoryID, ok := number(*c.RepositoryID, false)
		if !ok || repositoryID != *r.RepositoryID {
			return bad()
		}
	} else if c.RepositoryID != nil {
		return bad()
	}
	if c.V != expectedVersion || len(seen) != expectedFields {
		return bad()
	}

	if c.ProjectID != id || c.State != r.State || c.Q != r.Query || c.Limit != r.Limit || (c.Direction != "next" && c.Direction != "previous") || (anchor > upper && !(c.Direction == "next" && upper < int64(^uint64(0)>>1) && anchor == upper+1)) {
		return bad()
	}
	return &pageCursor{upper, anchor, c.Direction}, nil
}
func encodeCursor(id string, r ListRequest, upper, anchor int64, direction string) *string {
	c := cursorJSON{V: 1, ProjectID: id, State: r.State, Q: r.Query, Limit: r.Limit, UpperNumber: strconv.FormatInt(upper, 10), AnchorNumber: strconv.FormatInt(anchor, 10), Direction: direction}
	if r.AuthorID != nil {
		c.V = 2
		authorID := strconv.FormatInt(*r.AuthorID, 10)
		c.AuthorID = &authorID
	}
	if r.RepositoryID != nil {
		c.V = 3
		repositoryID := strconv.FormatInt(*r.RepositoryID, 10)
		c.RepositoryID = &repositoryID
	}
	b, _ := json.Marshal(c)
	s := base64.RawURLEncoding.EncodeToString(b)
	return &s
}
