package github

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

func TestAuthorCursorStrictContract(t *testing.T) {
	req := AuthorsRequest{Query: "中文", Limit: 2}
	valid := `{"v":1,"projectId":"` + projectID + `","q":"中文","limit":2,"revision":"0","nameKey":"same","authorId":"9007199254740997"}`
	encode := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	cursor, err := decodeAuthorCursor(encode(valid), projectID, req)
	if err != nil || cursor.revision != 0 || cursor.nameKey != "same" || cursor.authorID != 9007199254740997 {
		t.Fatalf("valid zero-revision cursor: %+v %v", cursor, err)
	}
	tests := []struct{ name, raw string }{
		{"unknown field", strings.Replace(valid, `"v":1`, `"v":1,"extra":1`, 1)},
		{"duplicate field", strings.Replace(valid, `"v":1`, `"v":1,"v":1`, 1)},
		{"missing field", strings.Replace(valid, `,"nameKey":"same"`, ``, 1)},
		{"null field", strings.Replace(valid, `"nameKey":"same"`, `"nameKey":null`, 1)},
		{"field case", strings.Replace(valid, `"projectId"`, `"ProjectId"`, 1)},
		{"trailing object", valid + ` {}`},
		{"trailing garbage", valid + `garbage`},
		{"not an object", `[]`},
		{"truncated object", valid[:len(valid)-1]},
		{"wrong version", strings.Replace(valid, `"v":1`, `"v":2`, 1)},
		{"wrong project", strings.Replace(valid, projectID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1)},
		{"wrong query", strings.Replace(valid, `"q":"中文"`, `"q":"other"`, 1)},
		{"wrong limit", strings.Replace(valid, `"limit":2`, `"limit":3`, 1)},
		{"wrong type", strings.Replace(valid, `"limit":2`, `"limit":"2"`, 1)},
		{"zero author", strings.Replace(valid, `"authorId":"9007199254740997"`, `"authorId":"0"`, 1)},
		{"negative author", strings.Replace(valid, `"authorId":"9007199254740997"`, `"authorId":"-1"`, 1)},
		{"signed author", strings.Replace(valid, `"authorId":"9007199254740997"`, `"authorId":"+1"`, 1)},
		{"leading zero author", strings.Replace(valid, `"authorId":"9007199254740997"`, `"authorId":"01"`, 1)},
		{"overflow author", strings.Replace(valid, `"authorId":"9007199254740997"`, `"authorId":"9223372036854775808"`, 1)},
		{"negative revision", strings.Replace(valid, `"revision":"0"`, `"revision":"-1"`, 1)},
		{"leading zero revision", strings.Replace(valid, `"revision":"0"`, `"revision":"00"`, 1)},
		{"overflow revision", strings.Replace(valid, `"revision":"0"`, `"revision":"9223372036854775808"`, 1)},
		{"nul name", strings.Replace(valid, `"nameKey":"same"`, `"nameKey":"\u0000"`, 1)},
		{"unpaired surrogate", strings.Replace(valid, `"nameKey":"same"`, `"nameKey":"\ud800"`, 1)},
		{"invalid utf8", strings.Replace(valid, `"nameKey":"same"`, "\"nameKey\":\"\xff\"", 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := decodeAuthorCursor(encode(test.raw), projectID, req)
			faultCode(t, err, "invalid_input")
		})
	}
	for _, test := range []struct{ name, encoded string }{
		{"padding", encode(valid) + "="},
		{"newline", encode(valid) + "\n"},
		{"bad alphabet", "!!!"},
		{"too long", strings.Repeat("a", transport.MaxEncodedCursorBytes+1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := decodeAuthorCursor(test.encoded, projectID, req)
			faultCode(t, err, "invalid_input")
		})
	}
}

func TestAuthorCursorEncodeRoundTripAndBudget(t *testing.T) {
	req := AuthorsRequest{Query: "%_", Limit: 100}
	author := githubpr.Author{ID: 9223372036854775807, NameKey: "name"}
	encoded, err := encodeAuthorCursor(projectID, req, 0, author)
	if err != nil || encoded == nil {
		t.Fatalf("encode: %v", err)
	}
	cursor, err := decodeAuthorCursor(*encoded, projectID, req)
	if err != nil || cursor.authorID != author.ID || cursor.nameKey != author.NameKey || cursor.revision != 0 {
		t.Fatalf("round trip: %+v %v", cursor, err)
	}
	author.NameKey = strings.Repeat("x", transport.MaxEncodedCursorBytes)
	if encoded, err := encodeAuthorCursor(projectID, req, 0, author); err == nil || encoded != nil {
		t.Fatalf("oversized cursor: %v %v", encoded, err)
	}
}
