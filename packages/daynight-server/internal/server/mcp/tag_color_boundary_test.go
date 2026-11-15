package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

func TestTagColorWriteEquivalentRESTBodyLimit(t *testing.T) {
	for _, tool := range []string{"tag_create", "tag_update"} {
		t.Run(tool, func(t *testing.T) {
			// Independently encode the equivalent REST body with JSON.stringify-style
			// HTML handling; quotes, backslashes, controls and UTF-8 count as bytes.
			name := "标签\"\\\n"
			body := map[string]any{"name": name, "color": "#abcdef"}
			if tool == "tag_update" {
				body["version"] = json.Number("9007199254740993")
			}
			encode := func() int {
				var b bytes.Buffer
				encoder := json.NewEncoder(&b)
				encoder.SetEscapeHTML(false)
				if err := encoder.Encode(body); err != nil {
					t.Fatal(err)
				}
				return b.Len() - 1 // Encoder appends a newline.
			}
			name += strings.Repeat(" ", httpx.MaxJSONBody-encode())
			body["name"] = name
			if got := encode(); got != httpx.MaxJSONBody {
				t.Fatalf("encoded body = %d, want %d", got, httpx.MaxJSONBody)
			}

			calls := 0
			ops := tagTestOperations{t: t}
			ops.createColor = func(_ context.Context, _ model.Principal, project, got string, color *string) (tagservice.WriteResult, error) {
				calls++
				if project != testProjectID || got != name || color == nil || *color != "#abcdef" {
					t.Error("create arguments changed")
				}
				return tagTestWrite(tagTestItem("accepted")), nil
			}
			ops.update = func(_ context.Context, _ model.Principal, project, id string, version int64, got, color *string) (tagservice.WriteResult, error) {
				calls++
				if project != testProjectID || id != testTargetID || version != 9007199254740993 || got == nil || *got != name || color == nil || *color != "#abcdef" {
					t.Error("update arguments changed")
				}
				return tagTestWrite(tagTestItem("accepted")), nil
			}
			f := newEntryFixture(t)
			if err := RegisterTagTools(f.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			args := map[string]any{"projectId": testProjectID, "name": name, "color": "#abcdef"}
			if tool == "tag_update" {
				args["tagId"] = testTargetID
				args["ifVersion"] = "9007199254740993"
			}
			result := tagTestCall(t, client, tool, args)
			if result.IsError || calls != 1 || object(t, structured(t, result)["meta"])["writeOutcome"] != "confirmed" {
				t.Fatalf("at limit: %+v calls=%d", structured(t, result), calls)
			}
			args["name"] = name + " "
			body["name"] = name + " "
			if got := encode(); got != httpx.MaxJSONBody+1 {
				t.Fatalf("over-limit body = %d", got)
			}
			result = tagTestCall(t, client, tool, args)
			failure := object(t, structured(t, result)["error"])
			if !result.IsError || calls != 1 || failure["code"] != "invalid_input" || failure["writeOutcome"] != "not_committed" || failure["phase"] != "prepare" || object(t, failure["refs"])["projectId"] != testProjectID {
				t.Fatalf("over limit: %+v calls=%d", failure, calls)
			}
			if tool == "tag_update" && object(t, failure["refs"])["tagId"] != testTargetID {
				t.Fatalf("update refs: %+v", failure)
			}
		})
	}
}

type tagColorTestAuthenticator struct{}

func (tagColorTestAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, _ string) (model.Principal, error) {
	return model.Principal{Kind: kind, UserID: testProjectID, CredentialID: testTargetID}, nil
}

type countedColorService struct {
	*tagservice.Tags
	calls int
}

func (s *countedColorService) Create(ctx context.Context, p model.Principal, project, name string, color *string) (tagservice.WriteResult, error) {
	s.calls++
	return s.Tags.Create(ctx, p, project, name, color)
}

func (s *countedColorService) Update(ctx context.Context, p model.Principal, project, id string, version int64, name, color *string) (tagservice.WriteResult, error) {
	s.calls++
	return s.Tags.Update(ctx, p, project, id, version, name, color)
}

func TestTagColorInvalidReachesRealServiceWithoutWrite(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.auth = tagColorTestAuthenticator{}
	// Invalid colors must fail service validation before the nil database is used.
	service := &countedColorService{Tags: tagservice.New(nil)}
	if err := RegisterTagTools(f.entry, service); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, tc := range []struct {
		tool string
		args map[string]any
	}{
		{"tag_create", map[string]any{"projectId": testProjectID, "name": "valid", "color": "#12z456"}},
		{"tag_update", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1", "color": "#12345"}},
	} {
		before := service.calls
		result := tagTestCall(t, client, tc.tool, tc.args)
		failure := object(t, structured(t, result)["error"])
		if !result.IsError || service.calls != before+1 || failure["code"] != "invalid_tag_color" || failure["writeOutcome"] != "not_committed" || failure["phase"] != "prepare" || object(t, failure["refs"])["projectId"] != testProjectID {
			t.Fatalf("%s: %+v calls=%d", tc.tool, failure, service.calls-before)
		}
		if tc.tool == "tag_update" && object(t, failure["refs"])["tagId"] != testTargetID {
			t.Fatalf("update refs: %+v", failure)
		}
		validateDiscoveredResult(t, client, tc.tool, result)
	}
}
