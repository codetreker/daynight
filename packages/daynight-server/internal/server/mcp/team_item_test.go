package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type teamItemReaderFunc func(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error)

func (f teamItemReaderFunc) Read(ctx context.Context, a teamitem.Authority, in teamitem.Input) (teamitem.Result, error) {
	return f(ctx, a, in)
}

func itemMemberMetadata(content string) teamitem.Metadata {
	now := time.Date(2026, 11, 6, 12, 0, 0, 123456000, time.UTC)
	return teamitem.Metadata{Member: &model.TeamMember{TeamID: unknownTeam, UserID: unknownTarget, Role: model.ProjectMemberRole, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}, Revision: "exact-timestamp-revision", Fields: []teamitem.Field{{Name: "profile.name", SizeBytes: int64(len(content))}, {Name: "profile.email", IsNull: true}, {Name: "profile.avatarUrl"}}}
}

func itemMemberReader(content string) teamItemReaderFunc {
	metadata := itemMemberMetadata(content)
	return func(_ context.Context, _ teamitem.Authority, in teamitem.Input) (teamitem.Result, error) {
		if in.Action == "inspect" {
			if in.MaxBytes != 0 {
				return teamitem.Result{}, errors.New("inspect received chunk byte limit")
			}
			return teamitem.Result{Metadata: metadata}, nil
		}
		if in.Revision != metadata.Revision {
			return teamitem.Result{}, &model.Fault{Code: "version_conflict", Message: "Item changed."}
		}
		if in.Field == "profile.email" {
			return teamitem.Result{}, &model.Fault{Code: "invalid_input", Message: "A null field has no chunks."}
		}
		value := content
		if in.Field == "profile.avatarUrl" {
			value = ""
		}
		if in.Offset > int64(len(value)) {
			return teamitem.Result{}, &model.Fault{Code: "invalid_input", Message: "Offset exceeds field size."}
		}
		end := min(int64(len(value)), in.Offset+int64(in.MaxBytes))
		return teamitem.Result{Metadata: metadata, Content: []byte(value[in.Offset:end]), Offset: in.Offset, EOF: end == int64(len(value))}, nil
	}
}

func mirroredEnvelope(t *testing.T, result *sdk.CallToolResult) map[string]any {
	t.Helper()
	if result == nil || len(result.Content) != 1 {
		t.Fatalf("missing content: %+v", result)
	}
	text, ok := result.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("unexpected content type %T", result.Content[0])
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(text.Text), &envelope); err != nil {
		t.Fatalf("text content is not the complete JSON envelope: %v", err)
	}
	if !reflect.DeepEqual(envelope, structured(t, result)) {
		t.Fatal("text and structured envelopes differ")
	}
	return envelope
}

func memberItemArguments(action string) map[string]any {
	return map[string]any{"kind": "member", "team": unknownTeam, "userId": unknownTarget, "action": action}
}

func TestTeamItemReadReconstructsFromTextOnlyResults(t *testing.T) {
	content := strings.Repeat("\"\x01名😀", 1900)
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		for _, format := range []string{"text", "base64", "large-base64"} {
			t.Run(protocol+"/"+format, func(t *testing.T) {
				f := newEntryFixture(t)
				if err := RegisterTeamItemTool(f.entry, itemMemberReader(content)); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, protocol, "alice")
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: memberItemArguments("inspect")})
				if err != nil || result.IsError {
					t.Fatalf("inspect: %+v, %v", result, err)
				}
				inspect := object(t, mirroredEnvelope(t, result)["data"])
				header := object(t, inspect["header"])
				if inspect["projection"] != "metadata" || inspect["contentIncluded"] != false || header["profile"] != nil || header["version"] != "9007199254740993" || header["updatedAt"] != "2026-11-06T12:00:00.123456Z" {
					t.Fatalf("incorrect fixed header: %#v", inspect)
				}
				fields := inspect["fields"].([]any)
				if len(fields) != 3 || object(t, fields[0])["sizeBytes"] != strconv.Itoa(len(content)) || object(t, fields[1])["isNull"] != true || object(t, fields[2])["sizeBytes"] != "0" || object(t, fields[2])["isNull"] != false {
					t.Fatalf("null/empty descriptors: %#v", fields)
				}
				var rebuilt strings.Builder
				offset := "0"
				for calls := 0; ; calls++ {
					if calls > len(content) {
						t.Fatal("chunk loop did not terminate")
					}
					args := memberItemArguments("chunk")
					args["field"], args["offset"], args["revision"] = "profile.name", offset, inspect["revision"]
					if format != "text" {
						args["format"] = "base64"
					}
					limit := teamListBudget
					if format == "large-base64" {
						args["maxBytes"] = 524288
						limit = teamItemLargeResultBytes
					}
					result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: args})
					if err != nil || result.IsError {
						t.Fatalf("chunk: %+v, %v", result, err)
					}
					wire, _ := json.Marshal(result)
					if len(wire) > limit {
						t.Fatalf("complete tool result %d exceeds %d", len(wire), limit)
					}
					data := object(t, mirroredEnvelope(t, result)["data"])
					if data["offset"] != offset {
						t.Fatalf("noncontiguous offset: %#v", data)
					}
					var bytes []byte
					if format == "text" {
						bytes = []byte(data["text"].(string))
					} else {
						bytes, err = base64.StdEncoding.DecodeString(data["contentBase64"].(string))
						if err != nil {
							t.Fatal(err)
						}
					}
					if data["readBytes"] != strconv.Itoa(len(bytes)) || len(bytes) == 0 {
						t.Fatalf("incorrect progress: %#v", data)
					}
					rebuilt.Write(bytes)
					offset = data["nextOffset"].(string)
					if data["eof"] == true {
						break
					}
				}
				if rebuilt.String() != content || offset != strconv.Itoa(len(content)) {
					t.Fatal("reconstructed field bytes differ")
				}
			})
		}
	}
}

func TestTeamItemReadChunkBoundariesAndFailures(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterTeamItemTool(f.entry, itemMemberReader("名😀Z")); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, tc := range []struct {
		name, field, offset, format, revision, code string
		max                                         int
		want                                        []byte
		eof                                         bool
	}{
		{name: "UTF8 start", offset: "1", code: "invalid_input", max: 4},
		{name: "UTF8 budget", offset: "0", code: "invalid_input", max: 1},
		{name: "byte slice", offset: "1", format: "base64", max: 1, want: []byte("名")[1:2]},
		{name: "rune boundary", offset: "0", max: 4, want: []byte("名")},
		{name: "EOF", offset: "8", max: 1, eof: true},
		{name: "past EOF", offset: "9", max: 1, code: "invalid_input"},
		{name: "null", field: "profile.email", offset: "0", max: 1, code: "invalid_input"},
		{name: "empty", field: "profile.avatarUrl", offset: "0", max: 1, eof: true},
		{name: "changed", offset: "0", revision: "stale", max: 4, code: "version_conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := memberItemArguments("chunk")
			args["field"], args["offset"], args["maxBytes"], args["revision"] = "profile.name", tc.offset, tc.max, "exact-timestamp-revision"
			if tc.field != "" {
				args["field"] = tc.field
			}
			if tc.format != "" {
				args["format"] = tc.format
			}
			if tc.revision != "" {
				args["revision"] = tc.revision
			}
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: args})
			if err != nil || result.IsError != (tc.code != "") {
				t.Fatalf("call: %+v %v", result, err)
			}
			env := mirroredEnvelope(t, result)
			if tc.code != "" {
				failure := object(t, env["error"])
				if failure["code"] != tc.code || failure["writeOutcome"] != nil || env["data"] != nil {
					t.Fatalf("failure leaked data or write receipt: %#v", env)
				}
				return
			}
			data := object(t, env["data"])
			var got []byte
			if tc.format == "base64" {
				got, err = base64.StdEncoding.DecodeString(data["contentBase64"].(string))
			} else {
				got = []byte(data["text"].(string))
			}
			if err != nil || string(got) != string(tc.want) || data["eof"] != tc.eof || data["readBytes"] != strconv.Itoa(len(tc.want)) {
				t.Fatalf("chunk=%#v bytes=%x err=%v", data, got, err)
			}
		})
	}
}

func TestTeamItemReadRejectsMalformedRequestsBeforeService(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	if err := RegisterTeamItemTool(f.entry, teamItemReaderFunc(func(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error) {
		calls++
		return teamitem.Result{}, errors.New("must not run")
	})); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, change := range []map[string]any{{"offset": "01"}, {"offset": "9223372036854775808"}, {"offset": "-1"}, {"maxBytes": 0}, {"maxBytes": 524289}, {"format": "auto"}, {"field": "repoUrl"}, {"projectId": unknownTarget}, {"action": "inspect"}} {
		args := memberItemArguments("chunk")
		args["revision"], args["field"], args["offset"] = "current", "profile.name", "0"
		for key, value := range change {
			args[key] = value
		}
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: args})
		if err != nil || !result.IsError || object(t, mirroredEnvelope(t, result)["error"])["code"] != "invalid_input" || calls != 0 {
			t.Fatalf("malformed %#v: %+v, %v; calls=%d", args, result, err, calls)
		}
	}
}

func TestTeamItemReadSnapshotsNeverProduceWriteReceipts(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterTeamItemTool(f.entry, teamItemReaderFunc(func(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error) {
		return teamitem.Result{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("database failure")}
	})); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: memberItemArguments("inspect")})
	if err != nil || !result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	env := mirroredEnvelope(t, result)
	if object(t, env["error"])["writeOutcome"] != nil || env["data"] != nil {
		t.Fatalf("read snapshot failure manufactured write outcome: %#v", env)
	}
}

func TestTeamResultPoliciesAndSafeReferences(t *testing.T) {
	for _, tc := range []struct {
		name, args string
		mirror     bool
		max        int
	}{
		{"team_list", `{}`, true, teamListBudget},
		{"team_member_list", `{}`, true, teamListBudget},
		{"team_projects", `{}`, true, teamListBudget},
		{"team_item_read", `{"action":"chunk","format":"base64"}`, true, teamListBudget},
		{"team_item_read", `{"action":"chunk","maxBytes":8192}`, true, teamListBudget},
		{"team_item_read", `{"action":"inspect","maxBytes":524288}`, true, teamListBudget},
		{"team_item_read", `{"action":"chunk","maxBytes":8193}`, true, teamItemLargeResultBytes},
		{"task_attachment_read", `{}`, false, 128 << 20},
	} {
		p := resultPolicy(tc.name, json.RawMessage(tc.args))
		if p.mirrorText != tc.mirror || p.maxBytes != tc.max {
			t.Fatalf("%s %s: %+v", tc.name, tc.args, p)
		}
	}
	refs := teamItemReadReference("member", unknownTeam, unknownTarget, "", "after-item")
	if !validItemReadReference("team_member_list", refs) {
		t.Fatal("complete read reference rejected")
	}
	delete(refs, "cursorAfterItem")
	if validItemReadReference("team_member_list", refs) {
		t.Fatal("incomplete read reference accepted")
	}
	got := teamLogReferences("team_item_read", map[string]any{"teamId": unknownTeam, "userId": "private name", "projectId": unknownTarget, "returnedBytes": "17", "revision": "private", "text": "private"})
	want := []any{"team_id", unknownTeam, "project_id", unknownTarget, "returned_bytes", int64(17)}
	if !reflect.DeepEqual(got, want) || len(teamLogReferences("other", map[string]any{"teamId": unknownTeam})) != 0 || len(teamLogReferences("team_item_read", map[string]any{"returnedBytes": "01"})) != 0 {
		t.Fatalf("unsafe logging attributes: %#v", got)
	}
}
