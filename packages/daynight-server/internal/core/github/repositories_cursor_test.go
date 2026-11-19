package github

import (
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

func TestRepositoryCursorStrictScope(t *testing.T) {
	anchor := int64(9223372036854775807)
	encoded := *encodeRepositoryCursor(projectID, anchor)
	got, err := decodeRepositoryCursor(encoded, projectID)
	if err != nil || *got != anchor {
		t.Fatalf("anchor=%v err=%v", got, err)
	}
	valid := `{"v":1,"projectId":"` + projectID + `","afterRepositoryId":"42"}`
	for _, raw := range []string{
		`{}`, `[]`, valid + `{}`, strings.Replace(valid, `"v":1`, `"v":2`, 1),
		strings.Replace(valid, `"v":1`, `"v":1,"v":1`, 1),
		strings.Replace(valid, `"v":1`, `"v":1,"extra":1`, 1),
		strings.Replace(valid, `"42"`, `null`, 1), strings.Replace(valid, `"42"`, `42`, 1),
		strings.Replace(valid, `"42"`, `"0"`, 1), strings.Replace(valid, `"42"`, `"042"`, 1),
		strings.Replace(valid, `"42"`, `"9223372036854775808"`, 1), strings.Replace(valid, projectID, "other", 1),
	} {
		_, err := decodeRepositoryCursor(encodedJSON(raw), projectID)
		faultCode(t, err, "invalid_input")
	}
	for _, invalid := range []string{"!", encoded + "=", strings.Repeat("a", transport.MaxEncodedCursorBytes+1)} {
		_, err := decodeRepositoryCursor(invalid, projectID)
		faultCode(t, err, "invalid_input")
	}
}

func TestSourceBoundReadCursors(t *testing.T) {
	source, other, author := int64(9007199254740993), int64(9007199254740994), int64(12)
	for _, authorID := range []*int64{nil, &author} {
		req := ListRequest{RepositoryID: &source, AuthorID: authorID, State: "all", Query: "match", Limit: 2}
		encoded := *encodeCursor(projectID, req, 42, 30, "next")
		if _, err := decodeCursor(encoded, projectID, req); err != nil {
			t.Fatal(err)
		}
		for _, repositoryID := range []*int64{nil, &other} {
			changed := req
			changed.RepositoryID = repositoryID
			_, err := decodeCursor(encoded, projectID, changed)
			faultCode(t, err, "invalid_input")
		}
		legacy := req
		legacy.RepositoryID = nil
		_, err := decodeCursor(*encodeCursor(projectID, legacy, 42, 30, "next"), projectID, req)
		faultCode(t, err, "invalid_input")
	}
	req := AuthorsRequest{RepositoryID: &source, Query: "match", Limit: 2}
	encoded, err := encodeAuthorCursor(projectID, req, 7, githubpr.Author{ID: author, NameKey: "name"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = decodeAuthorCursor(*encoded, projectID, req); err != nil {
		t.Fatal(err)
	}
	for _, repositoryID := range []*int64{nil, &other} {
		changed := req
		changed.RepositoryID = repositoryID
		_, err := decodeAuthorCursor(*encoded, projectID, changed)
		faultCode(t, err, "invalid_input")
	}
	legacy := req
	legacy.RepositoryID = nil
	old, err := encodeAuthorCursor(projectID, legacy, 7, githubpr.Author{ID: author, NameKey: "name"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = decodeAuthorCursor(*old, projectID, req)
	faultCode(t, err, "invalid_input")
}
