package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const testProjectID = "11111111-1111-4111-8111-111111111111"
const testTeamID = "22222222-2222-4222-8222-222222222222"
const testTargetID = "abcdefab-abcd-4abc-8abc-abcdefabcdef"
const testUserID = "44444444-4444-4444-8444-444444444444"

type fakeProjectOperations struct {
	project       model.Project
	page          coreproject.ProjectPage
	preview       coreproject.TransferPreview
	receipt       coreproject.TransferReceipt
	transferInput coreproject.TransferInput
	createInput   coreproject.CreateProject
	confirm       bool
	err           error
	transferErr   error
	calls         int
	previews      int
}

func (f *fakeProjectOperations) RegisterRepository(_ context.Context, _ model.Principal, in coreproject.CreateProject, confirm bool) (model.Project, bool, error) {
	f.createInput, f.confirm = in, confirm
	return f.project, confirm, f.err
}
func (f *fakeProjectOperations) Get(context.Context, model.Principal, string) (model.Project, error) {
	return f.project, f.err
}
func (f *fakeProjectOperations) ListAdmitted(_ context.Context, principal model.Principal, request coreproject.ProjectListRequest, measure func([]model.Project, *string) error) (coreproject.ProjectPage, error) {
	if f.err != nil {
		return coreproject.ProjectPage{}, f.err
	}
	out := coreproject.ProjectPage{Items: []model.Project{}}
	for i, item := range f.page.Items {
		cursor, err := query.EncodeProjectCursor(item, principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
		if err != nil {
			return coreproject.ProjectPage{}, err
		}
		var next *string
		if i+1 < len(f.page.Items) || f.page.NextCursor != nil {
			next = &cursor
		}
		candidate := append(out.Items, item)
		if err := measure(candidate, next); err != nil {
			if len(out.Items) == 0 {
				return coreproject.ProjectPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Project exceeds the encoded page limit."}
			}
			previous, err := query.EncodeProjectCursor(out.Items[len(out.Items)-1], principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
			if err != nil {
				return coreproject.ProjectPage{}, err
			}
			out.NextCursor = &previous
			return out, nil
		}
		out.Items = candidate
		if len(out.Items) == request.Page.Limit {
			out.NextCursor = next
			return out, nil
		}
	}
	return out, nil
}
func (f *fakeProjectOperations) TransferPreview(context.Context, model.Principal, string, string) (coreproject.TransferPreview, error) {
	f.previews++
	return f.preview, f.err
}
func (f *fakeProjectOperations) Transfer(_ context.Context, _ model.Principal, _ string, in coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	f.calls++
	f.transferInput = in
	return f.receipt, f.transferErr
}

func sampleProject(id string) model.Project {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Project{ID: id, Name: "sample", RepoURL: "https://example.com/owner/repo", CreatedAt: now, UpdatedAt: now, Settings: model.ProjectSettings{Version: 9007199254740993}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 9007199254740994, UpdatedAt: now}}
}
func projectActor() RequestActor {
	return RequestActor{Principal: model.Principal{UserID: testUserID}, RequestID: "test-request"}
}
func TestProjectCreateBusinessBodyMatchesJSONAndLimit(t *testing.T) {
	// JSON.stringify keeps HTML characters and U+2028 as UTF-8, but escapes controls.
	if n := projectCreateBodySize("<>&\u2028\n\x01", "r", testTeamID, testUserID); n != len(`{"name":"<>&`)+3+len(`\n\u0001","repoUrl":"r","teamId":"`)+len(testTeamID)+len(`","expectedUserId":"`)+len(testUserID)+len(`"}`) {
		t.Fatalf("body size %d", n)
	}
	f := &fakeProjectOperations{project: sampleProject(testProjectID)}
	h := projectTools{projects: f}
	input := projectCreateInput{RepoURL: "r", Team: testTeamID, Confirm: true}
	overhead := projectCreateBodySize("", input.RepoURL, input.Team, testUserID)
	input.Name = strings.Repeat("<", httpx.MaxJSONBody-overhead)
	if _, err := h.create(context.Background(), projectActor(), input); err != nil {
		t.Fatalf("boundary %v", err)
	}
	input.Name += "<"
	if _, err := h.create(context.Background(), projectActor(), input); err == nil {
		t.Fatal("oversized body accepted")
	}
}
func TestProjectIdentifierAcceptsOnlySameServiceExactLinks(t *testing.T) {
	tests := []struct {
		input string
		valid bool
	}{
		{testTargetID, true}, {"https://daynight.test/teams/" + testTargetID, true}, {"https://DAYNIGHT.test:443/teams/" + testTargetID, true},
		{"https://other.test/teams/" + testTargetID, false}, {"https://daynight.test/teams/" + testTargetID + "?", false},
		{"https://daynight.test/teams/" + testTargetID + "/", false}, {"https://daynight.test/teams/%33" + testTargetID[1:], false},
		{"https://user@daynight.test/teams/" + testTargetID, false}, {strings.ToUpper(testTargetID), false},
		{"https://daynight.test/teams/" + strings.ToUpper(testTargetID), false},
		{"https://daynight.test/Teams/" + testTargetID, false},
		{"https://%zz/teams/" + testTargetID, false},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			id, err := teamIdentifier(tt.input, "https://daynight.test")
			if (err == nil) != tt.valid || tt.valid && id != testTargetID {
				t.Fatalf("got %q, %v", id, err)
			}
		})
	}
}
func TestProjectTransferPreservesVersionsReceiptsAndUnknown(t *testing.T) {
	p := sampleProject(testProjectID)
	f := &fakeProjectOperations{preview: coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, Ownership: p.Ownership, TargetTeamVersion: 77}, receipt: coreproject.TransferReceipt{ProjectID: p.ID, Changed: true, SourceTeam: model.TeamRef{ID: testTeamID}, OwnerTeam: model.TeamRef{ID: testTargetID}, Ownership: model.ProjectOwnership{TeamID: testTargetID, Version: 9007199254740995}}}
	h := projectTools{projects: f, origin: "https://daynight.test"}
	ver := "9007199254740992"
	result, err := h.transfer(context.Background(), projectActor(), projectTransferInput{ProjectID: p.ID, ToTeam: testTargetID, IfVersion: &ver, Confirm: true})
	if err != nil || f.transferInput.Ownership.Version != 9007199254740992 || f.transferInput.TargetTeam.Version != 77 || f.transferInput.ExpectedUserID != testUserID || result.Outcome != "changed" || result.WriteOutcome != "confirmed" {
		t.Fatalf("input=%+v result=%+v err=%v", f.transferInput, result, err)
	}
	data := result.Data.(map[string]any)
	if data["actorAccess"] != (*projectAccessWire)(nil) || data["ownership"].(ProjectOwnership).Version != "9007199254740995" {
		t.Fatalf("receipt %+v", data)
	}
	f.transferErr = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("lost")}
	result, err = h.transfer(context.Background(), projectActor(), projectTransferInput{ProjectID: p.ID, ToTeam: testTargetID, Confirm: true})
	if err == nil || result.Refs["sourceTeamId"] != testTeamID || result.Refs["targetTeamId"] != testTargetID {
		t.Fatalf("unknown result %+v %v", result, err)
	}
	f.transferErr = &model.Fault{Code: "version_conflict", Message: "Target Team has changed."}
	f.previews, f.calls = 0, 0
	_, err = h.transfer(context.Background(), projectActor(), projectTransferInput{ProjectID: p.ID, ToTeam: testTargetID, Confirm: true})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" || f.previews != 1 || f.calls != 1 {
		t.Fatalf("target version conflict: previews=%d writes=%d error=%v", f.previews, f.calls, err)
	}
	f.transferErr = nil
	f.calls = 0
	if _, err = h.transfer(context.Background(), projectActor(), projectTransferInput{ProjectID: p.ID, ToTeam: testTargetID, IfVersion: ptr("9223372036854775808"), Confirm: true}); err == nil || f.calls != 0 {
		t.Fatalf("overflow: %v, calls=%d", err, f.calls)
	}
}
func ptr(s string) *string { return &s }
func TestProjectListBudgetRetainsCursorAtLastIncludedItem(t *testing.T) {
	f := &fakeProjectOperations{}
	for i := range 5 {
		p := sampleProject(fmt.Sprintf("%08x-1111-4111-8111-111111111111", i+1))
		p.Name = strings.Repeat("<", 500000)
		f.page.Items = append(f.page.Items, p)
	}
	h := projectTools{projects: f}
	result, err := h.list(context.Background(), projectActor(), projectListInput{})
	if err != nil {
		t.Fatal(err)
	}
	page := result.Data.(projectPage)
	if len(page.Items) == 0 || len(page.Items) >= 5 || page.NextCursor == nil {
		t.Fatalf("page has %d items and cursor %v", len(page.Items), page.NextCursor)
	}
	// Existing query decoder verifies the cursor's actual final item and account scope.
	decoded, err := queryProjectCursor(*page.NextCursor)
	if err != nil || decoded != f.page.Items[len(page.Items)-1].ID {
		t.Fatalf("cursor %q %v", decoded, err)
	}
}

func TestProjectListOversizedFirstItemProvidesRecovery(t *testing.T) {
	project := sampleProject(testProjectID)
	project.Name = strings.Repeat("<", 800000)
	h := projectTools{projects: &fakeProjectOperations{page: coreproject.ProjectPage{Items: []model.Project{project}}}}
	_, err := h.list(context.Background(), projectActor(), projectListInput{})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("oversized: %v", err)
	}
}
func queryProjectCursor(cursor string) (string, error) {
	page, err := query.ProjectListPage(model.PageRequest{Limit: 1, Cursor: &cursor}, testUserID, store.ProjectScope{Kind: store.ProjectScopeAll})
	if err != nil {
		return "", err
	}
	return page.After.ID, nil
}
func TestProjectToolHTTPDiscoveryAndInputs(t *testing.T) {
	f := newEntryFixture(t)
	project := sampleProject(testProjectID)
	ops := &fakeProjectOperations{project: project}
	if err := RegisterProjectTools(f.entry, ops, nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	listing, err := client.ListTools(ctx, nil)
	if err != nil || len(listing.Tools) != 5 {
		t.Fatalf("tools: %+v %v", listing, err)
	}
	call := func(name string, args any) *sdk.CallToolResult {
		r, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	result := call("project_show", map[string]any{"projectId": testProjectID})
	if result.IsError {
		t.Fatalf("show %+v", result)
	}
	doc := structured(t, result)
	data := object(t, doc["data"])
	if object(t, data["settings"])["version"] != "9007199254740993" {
		t.Fatalf("show %v", data)
	}
	result = call("project_create", map[string]any{"name": "new", "repoUrl": "https://example.com/a/b", "team": testTeamID, "confirm": true})
	if result.IsError || !ops.confirm || *ops.createInput.TeamID != testTeamID {
		t.Fatalf("create %+v %+v", result, ops.createInput)
	}
	result = call("project_create", map[string]any{"name": "new", "repoUrl": "x", "team": testTeamID, "confirm": false})
	if !result.IsError {
		t.Fatalf("false confirm accepted: %+v", result)
	}
	ops.preview = coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, Ownership: project.Ownership, TargetTeamVersion: 7}
	ops.transferErr = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("lost")}
	result = call("project_transfer", map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "confirm": true})
	failure := object(t, structured(t, result)["error"])
	refs := object(t, failure["refs"])
	if !result.IsError || failure["writeOutcome"] != "unknown" || refs["projectId"] != testProjectID || refs["targetTeamId"] != testTargetID {
		t.Fatalf("unknown transfer: %+v", failure)
	}
	result = call("project_list", map[string]any{"limit": 101})
	if !result.IsError {
		t.Fatalf("bad limit accepted: %+v", result)
	}
}

func TestProjectRegistrationRejectsMissingOrCorruptToolDefinitions(t *testing.T) {
	original := projectToolsJSON
	t.Cleanup(func() { projectToolsJSON = original })
	f := newEntryFixture(t)
	projectToolsJSON = []byte("[")
	if err := RegisterProjectTools(f.entry, &fakeProjectOperations{}, nil, "https://daynight.test"); err == nil {
		t.Fatal("corrupt tool definitions accepted")
	}
	var tools []map[string]any
	if err := json.Unmarshal(original, &tools); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"project_create", "project_transfer", "project_list", "project_show"} {
		t.Run(name, func(t *testing.T) {
			var filtered []map[string]any
			for _, tool := range tools {
				if tool["name"] != name {
					filtered = append(filtered, tool)
				}
			}
			encoded, err := json.Marshal(filtered)
			if err != nil {
				t.Fatal(err)
			}
			projectToolsJSON = encoded
			fixture := newEntryFixture(t)
			if err = RegisterProjectTools(fixture.entry, &fakeProjectOperations{}, nil, "https://daynight.test"); err == nil {
				t.Fatal("missing tool definition accepted")
			}
		})
	}
}

func TestProjectTransferMapsCompleteActorAccess(t *testing.T) {
	now := time.Date(2026, 1, 1, 1, 2, 3, 0, time.FixedZone("other", 8*60*60))
	role := model.ProjectAdmin
	access := &model.ProjectAccess{ProjectID: testProjectID, Role: model.ProjectAdmin, CanTransfer: true, TeamRole: &role,
		OwnerTeam: model.TeamRef{ID: testTeamID, Kind: "team"}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 9007199254740993, UpdatedAt: now},
		DirectGrant: &model.ProjectGrant{ProjectID: testProjectID, UserID: testUserID, Role: model.ProjectMemberRole, Version: 9007199254740995, CreatedAt: now, UpdatedAt: now}}
	out := mapProjectAccess(access)
	if out == nil || out.ProjectID != testProjectID || out.OwnerTeam.ID != testTeamID || out.TeamRole == nil || *out.TeamRole != role || !out.CanTransfer || out.EffectiveRole != role || out.Ownership.Version != "9007199254740993" || !out.Ownership.UpdatedAt.Equal(now) || out.Ownership.UpdatedAt.Location() != time.UTC {
		t.Fatalf("access mapping: %+v", out)
	}
	grant := out.DirectGrant
	if grant == nil || grant.ProjectID != testProjectID || grant.UserID != testUserID || grant.Role != model.ProjectMemberRole || grant.Version != "9007199254740995" || !grant.CreatedAt.Equal(now) || grant.CreatedAt.Location() != time.UTC {
		t.Fatalf("grant mapping: %+v", grant)
	}
	access.DirectGrant = nil
	if mapProjectAccess(access).DirectGrant != nil {
		t.Fatal("absent direct grant was not preserved")
	}
}

func TestProjectHandlersPreserveFailuresAndListBounds(t *testing.T) {
	refusal := &model.Fault{Code: "not_found", Message: "Project not found."}
	f := &fakeProjectOperations{err: refusal}
	h := projectTools{projects: f, origin: "https://daynight.test"}
	actor := projectActor()
	if _, err := h.create(context.Background(), actor, projectCreateInput{Team: "invalid"}); err == nil {
		t.Fatal("invalid team accepted")
	}
	if _, err := h.show(context.Background(), actor, projectShowInput{ProjectID: testProjectID}); !errors.Is(err, refusal) {
		t.Fatalf("show error: %v", err)
	}
	if _, err := h.list(context.Background(), actor, projectListInput{}); !errors.Is(err, refusal) {
		t.Fatalf("list error: %v", err)
	}
	if _, err := h.transfer(context.Background(), actor, projectTransferInput{ProjectID: testProjectID, ToTeam: "invalid"}); err == nil {
		t.Fatal("invalid transfer target accepted")
	}
	if _, err := h.transfer(context.Background(), actor, projectTransferInput{ProjectID: testProjectID, ToTeam: testTargetID}); !errors.Is(err, refusal) {
		t.Fatalf("preview error: %v", err)
	}
	f.err = nil
	project := sampleProject(testProjectID)
	project.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	f.page.Items = []model.Project{project}
	if _, err := h.list(context.Background(), actor, projectListInput{}); err == nil {
		t.Fatal("unencodable project accepted")
	}
	f.page.Items = append(f.page.Items, sampleProject(testProjectID))
	if _, err := h.list(context.Background(), actor, projectListInput{}); err == nil {
		t.Fatal("unencodable cursor accepted")
	}
}
