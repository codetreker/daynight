package mcp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tagcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type tagTestOperations struct {
	t      *testing.T
	list   func(context.Context, model.Principal, string, tagservice.ListInput) (tagservice.Page, error)
	get    func(context.Context, model.Principal, string, string) (tagservice.Item, error)
	create func(context.Context, model.Principal, string, string) (tagservice.WriteResult, error)
	rename func(context.Context, model.Principal, string, string, int64, string) (tagservice.WriteResult, error)
	delete func(context.Context, model.Principal, string, string, int64, bool) (tagservice.WriteResult, error)
}

func (f tagTestOperations) List(ctx context.Context, p model.Principal, project string, in tagservice.ListInput) (tagservice.Page, error) {
	if f.list == nil {
		f.t.Error("unexpected List")
		return tagservice.Page{}, errors.New("unexpected List")
	}
	return f.list(ctx, p, project, in)
}
func (f tagTestOperations) Get(ctx context.Context, p model.Principal, project, id string) (tagservice.Item, error) {
	if f.get == nil {
		f.t.Error("unexpected Get")
		return tagservice.Item{}, errors.New("unexpected Get")
	}
	return f.get(ctx, p, project, id)
}
func (f tagTestOperations) Create(ctx context.Context, p model.Principal, project, name string) (tagservice.WriteResult, error) {
	if f.create == nil {
		f.t.Error("unexpected Create")
		return tagservice.WriteResult{}, errors.New("unexpected Create")
	}
	return f.create(ctx, p, project, name)
}
func (f tagTestOperations) Rename(ctx context.Context, p model.Principal, project, id string, version int64, name string) (tagservice.WriteResult, error) {
	if f.rename == nil {
		f.t.Error("unexpected Rename")
		return tagservice.WriteResult{}, errors.New("unexpected Rename")
	}
	return f.rename(ctx, p, project, id, version, name)
}
func (f tagTestOperations) Delete(ctx context.Context, p model.Principal, project, id string, version int64, confirm bool) (tagservice.WriteResult, error) {
	if f.delete == nil {
		f.t.Error("unexpected Delete")
		return tagservice.WriteResult{}, errors.New("unexpected Delete")
	}
	return f.delete(ctx, p, project, id, version, confirm)
}

func tagTestItem(name string) tagservice.Item {
	stamp := time.Date(2026, 11, 13, 1, 2, 3, 0, time.UTC)
	return tagservice.Item{Tag: model.Tag{ID: testTargetID, ProjectID: testProjectID, Name: name, Version: 9007199254740993, CreatedAt: stamp, UpdatedAt: stamp}, Usage: model.TagUsage{Tasks: 2, Goals: 3}}
}
func tagTestWrite(item tagservice.Item) tagservice.WriteResult {
	return tagservice.WriteResult{Item: item, ProjectID: testProjectID, TagID: testTargetID, Phase: "commit", Outcome: store.TransactionCommitted}
}
func tagTestCall(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil || result == nil {
		t.Fatalf("%s: result=%+v err=%v", name, result, err)
	}
	return result
}
func tagTestActor(t *testing.T, ctx context.Context, p model.Principal, project string) {
	t.Helper()
	if ctx.Err() != nil || p.UserID != "alice" || p.CredentialID != "credential-alice" || project != testProjectID {
		t.Errorf("actor/context/project changed: %+v %q %v", p, project, ctx.Err())
	}
}

func TestTagToolsDiscoveryAndProtocol(t *testing.T) {
	for _, protocol := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(protocol, func(t *testing.T) {
			f := newEntryFixture(t)
			item := tagTestItem("backend")
			cursor := "opaque-next"
			calls := map[string]int{}
			ops := tagTestOperations{t: t}
			ops.list = func(ctx context.Context, p model.Principal, project string, in tagservice.ListInput) (tagservice.Page, error) {
				calls["list"]++
				tagTestActor(t, ctx, p, project)
				if in != (tagservice.ListInput{Query: "back", Limit: 7, Cursor: "opaque-prev"}) {
					t.Errorf("list input: %+v", in)
				}
				return tagservice.Page{Items: []tagservice.Item{item}, CatalogEpoch: testProjectID, NextCursor: &cursor}, nil
			}
			ops.get = func(ctx context.Context, p model.Principal, project, id string) (tagservice.Item, error) {
				calls["show"]++
				tagTestActor(t, ctx, p, project)
				if id != testTargetID {
					t.Errorf("id %q", id)
				}
				return item, nil
			}
			ops.create = func(ctx context.Context, p model.Principal, project, name string) (tagservice.WriteResult, error) {
				calls["create"]++
				tagTestActor(t, ctx, p, project)
				if name != "backend" {
					t.Errorf("name %q", name)
				}
				return tagTestWrite(item), nil
			}
			ops.rename = func(ctx context.Context, p model.Principal, project, id string, version int64, name string) (tagservice.WriteResult, error) {
				calls["rename"]++
				tagTestActor(t, ctx, p, project)
				if id != testTargetID || version != 9007199254740993 || name != "backend" {
					t.Errorf("rename: %q %d %q", id, version, name)
				}
				return tagTestWrite(item), nil
			}
			ops.delete = func(ctx context.Context, p model.Principal, project, id string, version int64, confirm bool) (tagservice.WriteResult, error) {
				calls["delete"]++
				tagTestActor(t, ctx, p, project)
				if id != testTargetID || version != 9007199254740993 || !confirm {
					t.Errorf("delete: %q %d %v", id, version, confirm)
				}
				result := tagTestWrite(item)
				result.Deleted = true
				return result, nil
			}
			if err := RegisterTagTools(f.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, protocol, "alice")
			listing, err := client.ListTools(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			expected := map[string]bool{"tag_list": true, "tag_show": true, "tag_create": true, "tag_rename": true, "tag_delete": true}
			for _, tool := range listing.Tools {
				if expected[tool.Name] {
					if tool.Description == "" || tool.InputSchema == nil || tool.OutputSchema == nil || tool.Annotations == nil {
						t.Errorf("incomplete discovery: %+v", tool)
					} else if a := tool.Annotations; a.ReadOnlyHint != (tool.Name == "tag_list" || tool.Name == "tag_show") || a.DestructiveHint == nil || *a.DestructiveHint != (tool.Name == "tag_delete") || a.OpenWorldHint == nil || *a.OpenWorldHint {
						t.Errorf("incorrect annotations for %s: %+v", tool.Name, a)
					}
					delete(expected, tool.Name)
				}
			}
			if len(expected) != 0 {
				t.Fatalf("missing tools: %+v", expected)
			}
			cases := []struct {
				name string
				args map[string]any
			}{
				{"tag_list", map[string]any{"projectId": testProjectID, "query": "back", "limit": 7, "cursor": "opaque-prev"}},
				{"tag_show", map[string]any{"projectId": testProjectID, "tagId": testTargetID}},
				{"tag_create", map[string]any{"projectId": testProjectID, "name": "backend"}},
				{"tag_rename", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "name": "backend"}},
				{"tag_delete", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "confirm": true}},
			}
			for _, tc := range cases {
				result := tagTestCall(t, client, tc.name, tc.args)
				if result.IsError {
					t.Fatalf("%s: %+v", tc.name, structured(t, result))
				}
				validateDiscoveredResult(t, client, tc.name, result)
				env := structured(t, result)
				data := object(t, env["data"])
				if tc.name == "tag_list" {
					if data["catalogEpoch"] != testProjectID || data["nextCursor"] != cursor || len(data["items"].([]any)) != 1 {
						t.Errorf("list: %+v", data)
					}
					data = object(t, data["items"].([]any)[0])
				}
				if tc.name == "tag_delete" {
					if data["projectId"] != testProjectID || data["tagId"] != testTargetID || data["deleted"] != true {
						t.Errorf("delete: %+v", data)
					}
				} else if data["id"] != testTargetID || data["projectId"] != testProjectID || data["name"] != "backend" || data["version"] != "9007199254740993" || object(t, data["usage"])["tasks"] != float64(2) {
					t.Errorf("tag: %+v", data)
				}
				if tc.name == "tag_create" || tc.name == "tag_rename" || tc.name == "tag_delete" {
					meta := object(t, env["meta"])
					if meta["writeOutcome"] != "confirmed" || meta["phase"] != "commit" {
						t.Errorf("completion: %+v", meta)
					}
				}
			}
			for _, name := range []string{"list", "show", "create", "rename", "delete"} {
				if calls[name] != 1 {
					t.Errorf("%s calls=%d", name, calls[name])
				}
			}
		})
	}
}

func TestTagToolsInputBoundaryAndCoreName(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	ops := tagTestOperations{t: t, create: func(ctx context.Context, p model.Principal, project, name string) (tagservice.WriteResult, error) {
		calls++
		normalized, _, err := tagcore.Name(name)
		if err != nil {
			return tagservice.WriteResult{Phase: "prepare", Outcome: store.TransactionNotCommitted}, err
		}
		return tagTestWrite(tagTestItem(normalized)), nil
	}}
	renameCalls := 0
	ops.rename = func(_ context.Context, _ model.Principal, _, _ string, version int64, name string) (tagservice.WriteResult, error) {
		renameCalls++
		if version != 1 {
			t.Errorf("rename version %d", version)
		}
		normalized, _, err := tagcore.Name(name)
		if err != nil {
			return tagservice.WriteResult{Phase: "prepare", Outcome: store.TransactionNotCommitted}, err
		}
		if name != " "+strings.Repeat("界", 64)+" " {
			t.Errorf("raw name changed: %q", name)
		}
		return tagTestWrite(tagTestItem(normalized)), nil
	}
	if err := RegisterTagTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	padded := " " + strings.Repeat("界", 64) + " "
	result := tagTestCall(t, client, "tag_create", map[string]any{"projectId": testProjectID, "name": padded})
	if result.IsError || calls != 1 || object(t, structured(t, result)["data"])["name"] != strings.Repeat("界", 64) {
		t.Fatalf("padded name was rejected: %+v calls=%d", structured(t, result), calls)
	}
	validateDiscoveredResult(t, client, "tag_create", result)
	result = tagTestCall(t, client, "tag_rename", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1", "name": padded})
	if result.IsError || renameCalls != 1 || object(t, structured(t, result)["data"])["name"] != strings.Repeat("界", 64) {
		t.Fatalf("padded rename: %+v calls=%d", structured(t, result), renameCalls)
	}
	validateDiscoveredResult(t, client, "tag_rename", result)
	for _, name := range []string{strings.Repeat("x", 65), "bad\x01name"} {
		before := calls
		result = tagTestCall(t, client, "tag_create", map[string]any{"projectId": testProjectID, "name": name})
		if !result.IsError || calls != before+1 || object(t, structured(t, result)["error"])["code"] != "invalid_tag_name" {
			t.Fatalf("invalid core name: %+v calls=%d", structured(t, result), calls)
		}
		validateDiscoveredResult(t, client, "tag_create", result)
	}
	for _, version := range []any{nil, "0", "01", "+1", "9223372036854775808", 1} {
		args := map[string]any{"projectId": testProjectID, "tagId": testTargetID, "name": "backend"}
		if version != nil {
			args["ifVersion"] = version
		}
		result = tagTestCall(t, client, "tag_rename", args)
		if !result.IsError {
			t.Errorf("accepted version %v", version)
		}
	}
	for _, confirm := range []any{nil, false} {
		args := map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1"}
		if confirm != nil {
			args["confirm"] = confirm
		}
		result = tagTestCall(t, client, "tag_delete", args)
		if !result.IsError {
			t.Errorf("accepted confirmation %v", confirm)
		}
	}
}

func TestTagToolsFailuresAndCompletion(t *testing.T) {
	for _, tc := range []struct {
		name              string
		outcome           store.TransactionOutcome
		phase             string
		cause             error
		code, wantOutcome string
	}{
		{"conflict", store.TransactionNotCommitted, "write", &model.Fault{Code: "version_conflict", Message: "Version changed."}, "version_conflict", "not_committed"},
		{"permission", store.TransactionNotCommitted, "query", &model.Fault{Code: "forbidden", Message: "Forbidden."}, "forbidden", "not_committed"},
		{"missing", store.TransactionNotCommitted, "query", &model.Fault{Code: "tag_not_found", Message: "Tag missing."}, "tag_not_found", "not_committed"},
		{"unknown", store.TransactionUnknown, "commit", errors.New("commit lost"), "internal_error", "unknown"},
		{"confirmed", store.TransactionCommitted, "commit", errors.New("cleanup failed"), "internal_error", "confirmed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			calls := 0
			ops := tagTestOperations{t: t, delete: func(ctx context.Context, p model.Principal, project, id string, version int64, confirm bool) (tagservice.WriteResult, error) {
				calls++
				return tagservice.WriteResult{ProjectID: project, TagID: id, Outcome: tc.outcome, Phase: tc.phase}, tc.cause
			}}
			if err := RegisterTagTools(f.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			result := tagTestCall(t, client, "tag_delete", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "9007199254740993", "confirm": true})
			if !result.IsError || calls != 1 {
				t.Fatalf("error/replay: %+v calls=%d", result, calls)
			}
			failure := object(t, structured(t, result)["error"])
			if failure["code"] != tc.code || failure["writeOutcome"] != tc.wantOutcome || failure["phase"] != tc.phase || object(t, failure["refs"])["tagId"] != testTargetID {
				t.Fatalf("completion: %+v", failure)
			}
			validateDiscoveredResult(t, client, "tag_delete", result)
		})
	}
	for _, code := range []string{"catalog_changed", "tag_not_found", "forbidden"} {
		t.Run(code, func(t *testing.T) {
			f := newEntryFixture(t)
			calls := 0
			ops := tagTestOperations{t: t, list: func(context.Context, model.Principal, string, tagservice.ListInput) (tagservice.Page, error) {
				calls++
				return tagservice.Page{}, &model.Fault{Code: code, Message: "Refused."}
			}}
			if err := RegisterTagTools(f.entry, ops); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			result := tagTestCall(t, client, "tag_list", map[string]any{"projectId": testProjectID, "cursor": "previous"})
			failure := object(t, structured(t, result)["error"])
			if !result.IsError || calls != 1 || failure["code"] != code || failure["writeOutcome"] != nil {
				t.Fatalf("list refusal: %+v calls=%d", failure, calls)
			}
			validateDiscoveredResult(t, client, "tag_list", result)
		})
	}
}

func TestTagToolsBudgetAndCancellation(t *testing.T) {
	f := newEntryFixture(t)
	ops := tagTestOperations{t: t}
	if err := RegisterTagTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	var releases []func()
	for range 16 {
		release, err := f.entry.budget.Acquire(t.Context(), BudgetControl)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"tag_list", map[string]any{"projectId": testProjectID}},
		{"tag_show", map[string]any{"projectId": testProjectID, "tagId": testTargetID}},
		{"tag_create", map[string]any{"projectId": testProjectID, "name": "x"}},
		{"tag_rename", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1", "name": "x"}},
		{"tag_delete", map[string]any{"projectId": testProjectID, "tagId": testTargetID, "ifVersion": "1", "confirm": true}},
	} {
		result := tagTestCall(t, client, tc.name, tc.args)
		if !result.IsError || object(t, structured(t, result)["error"])["code"] != "resource_busy" {
			t.Fatalf("%s budget: %+v", tc.name, structured(t, result))
		}
	}

	entered, finished := make(chan struct{}), make(chan struct{})
	ops.list = func(ctx context.Context, p model.Principal, project string, in tagservice.ListInput) (tagservice.Page, error) {
		close(entered)
		<-ctx.Done()
		close(finished)
		return tagservice.Page{}, ctx.Err()
	}
	cancelFixture := newEntryFixture(t)
	if err := RegisterTagTools(cancelFixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	cancelClient := cancelFixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = cancelClient.CallTool(ctx, &sdk.CallToolParams{Name: "tag_list", Arguments: map[string]any{"projectId": testProjectID}})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("business call did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("business call did not cancel")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("adapter did not exit")
	}
}

func TestTagConflictClassificationAndSafeLogging(t *testing.T) {
	conflict := tagcore.Unique(fmt.Errorf("%w: %w", store.ErrTagNameConflict, &store.Error{DatabaseFailure: true, SQLState: "23505", Cause: errors.New("private database text")}))
	validTx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}
	for _, err := range []error{
		&store.Error{DatabaseFailure: true, SQLState: "40001", Cause: validTx},
		errors.Join(validTx, errors.New("independent failure")),
	} {
		if safeTagNameConflict(err) {
			t.Fatalf("unsafe conflict exposed: %v", err)
		}
	}
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		tx      store.TransactionError
		outer   bool
		code    string
	}{
		{"reliable", store.TransactionNotCommitted, store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}, false, "tag_name_conflict"},
		{"project write wrapper", store.TransactionNotCommitted, store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: conflict}, true, "tag_name_conflict"},
		{"cleanup failure", store.TransactionNotCommitted, store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: conflict}, true, "internal_error"},
		{"unknown", store.TransactionUnknown, store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: conflict}, true, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			entry := additionalEntry(t, logger)
			calls := 0
			ops := tagTestOperations{t: t, create: func(context.Context, model.Principal, string, string) (tagservice.WriteResult, error) {
				calls++
				var err error = &tc.tx
				if tc.outer {
					err = &store.Error{Phase: "project write", DatabaseFailure: true, SQLState: "23505", Cause: err}
				}
				return tagservice.WriteResult{ProjectID: testProjectID, TagID: testTargetID, Outcome: tc.outcome, Phase: tc.tx.Phase, CleanupFailed: tc.tx.CleanupFailed}, err
			}}
			if err := RegisterTagTools(entry, ops); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(httpx.RequestLogging(logger, entry))
			t.Cleanup(server.Close)
			client := (&entryFixture{entry: entry, server: server}).client(t, "2026-07-28", "alice")
			result := tagTestCall(t, client, "tag_create", map[string]any{"projectId": testProjectID, "name": "private tag name"})
			failure := object(t, structured(t, result)["error"])
			if !result.IsError || calls != 1 || failure["code"] != tc.code {
				t.Fatalf("classification/replay: %+v calls=%d", failure, calls)
			}
			text := logs.String()
			if !strings.Contains(text, `"project_id":"`+testProjectID+`"`) || !strings.Contains(text, `"candidate_tag_id":"`+testTargetID+`"`) || strings.Contains(text, "private tag name") || strings.Contains(text, "private database text") {
				t.Fatalf("unsafe or missing log fields: %s", text)
			}
		})
	}
}
