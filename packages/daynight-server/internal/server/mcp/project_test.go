package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
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
	resolve       func(context.Context, model.Principal, string) (model.Project, error)
	err           error
	transferErr   error
	calls         int
	previews      int
}

func (f *fakeProjectOperations) RegisterRepository(_ context.Context, _ model.Principal, in coreproject.CreateProject, confirm bool) (model.Project, bool, error) {
	f.createInput, f.confirm = in, confirm
	return f.project, confirm, f.err
}
func (f *fakeProjectOperations) ResolveRepository(ctx context.Context, principal model.Principal, address string) (model.Project, error) {
	if f.resolve != nil {
		return f.resolve(ctx, principal, address)
	}
	return f.project, f.err
}
func (f *fakeProjectOperations) Get(context.Context, model.Principal, string) (model.Project, error) {
	return f.project, f.err
}
func (f *fakeProjectOperations) ListScoped(_ context.Context, _ model.Principal, _ coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	return f.page, f.err
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

type projectListOperation struct {
	projectOperations
	list func(context.Context, model.Principal, coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
}

func (operation projectListOperation) ListScoped(ctx context.Context, principal model.Principal, request coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	return operation.list(ctx, principal, request)
}

func TestProjectListMapsPagesAndForwardsInputs(t *testing.T) {
	at := time.Date(2026, 11, 9, 12, 34, 56, 0, time.FixedZone("local", 8*60*60))
	items := []model.Project{
		{ID: testProjectID, Name: "First <>& 中文", RepoURL: "git@github.com:org/first", CreatedAt: at, UpdatedAt: at.Add(time.Minute), Settings: model.ProjectSettings{Version: 9007199254740993, ExecutionWarningMinutes: 17}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 9007199254740994, UpdatedAt: at.Add(2 * time.Minute)}},
		{ID: testTargetID, Name: "Second", RepoURL: "https://example.com/org/second", CreatedAt: at.Add(3 * time.Minute), UpdatedAt: at.Add(4 * time.Minute), Settings: model.ProjectSettings{Version: 2}, Ownership: model.ProjectOwnership{TeamID: testTargetID, Version: 3, UpdatedAt: at.Add(4 * time.Minute)}},
	}
	mapped := []Project{
		{ID: testProjectID, Name: "First <>& 中文", RepoURL: "git@github.com:org/first", CreatedAt: at.UTC(), UpdatedAt: at.Add(time.Minute).UTC(), Settings: ProjectSettings{Version: "9007199254740993", ExecutionWarningMinutes: 17}, Ownership: ProjectOwnership{TeamID: testTeamID, Version: "9007199254740994", UpdatedAt: at.Add(2 * time.Minute).UTC()}},
		{ID: testTargetID, Name: "Second", RepoURL: "https://example.com/org/second", CreatedAt: at.Add(3 * time.Minute).UTC(), UpdatedAt: at.Add(4 * time.Minute).UTC(), Settings: ProjectSettings{Version: "2"}, Ownership: ProjectOwnership{TeamID: testTargetID, Version: "3", UpdatedAt: at.Add(4 * time.Minute).UTC()}},
	}
	cursor, limit := "project-page-2", 2
	failure := errors.New("Project list use case failed")
	for _, tc := range []struct {
		name    string
		input   projectListInput
		request coreproject.ProjectListRequest
		page    coreproject.ProjectPage
		want    projectPage
		err     error
	}{
		{name: "default count", request: coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 50}}, page: coreproject.ProjectPage{Items: items, NextCursor: &cursor}, want: projectPage{Items: mapped, NextCursor: &cursor}},
		{name: "explicit count and cursor", input: projectListInput{Limit: &limit, Cursor: &cursor}, request: coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 2, Cursor: &cursor}}, page: coreproject.ProjectPage{Items: items[1:]}, want: projectPage{Items: mapped[1:]}},
		{name: "use case failure", input: projectListInput{Limit: &limit, Cursor: &cursor}, request: coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 2, Cursor: &cursor}}, err: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			actor := projectActor()
			actor.Principal = model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTeamID}
			calls := 0
			operations := projectListOperation{list: func(actual context.Context, principal model.Principal, request coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
				calls++
				if actual != ctx || principal != actor.Principal || !reflect.DeepEqual(request, tc.request) {
					t.Fatalf("list use case context/principal/request: %v %+v %+v; want %+v", actual == ctx, principal, request, tc.request)
				}
				return tc.page, tc.err
			}}
			t.Cleanup(func() {
				if calls != 1 {
					t.Errorf("list use case calls=%d; want 1", calls)
				}
			})
			result, err := (&projectTools{projects: operations}).list(ctx, actor, tc.input)
			if err != tc.err {
				t.Fatalf("error=%v; want original %v", err, tc.err)
			}
			if result.Outcome != "" || result.WriteOutcome != "" || result.Phase != "" || result.Refs != nil {
				t.Fatalf("read result carried mutation facts: %+v", result)
			}
			if tc.err != nil {
				if result.Data != nil {
					t.Fatalf("failed list exposed data: %+v", result)
				}
				return
			}
			if page, ok := result.Data.(projectPage); !ok || !reflect.DeepEqual(page, tc.want) {
				t.Fatalf("page=%+v; want %+v", result.Data, tc.want)
			}
		})
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
	if err != nil || len(listing.Tools) != 6 {
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
	for _, name := range []string{"project_create", "project_transfer", "project_list", "project_resolve", "project_show"} {
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

func TestProjectHandlersPreserveFailures(t *testing.T) {
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
}

func TestMCPProjectProductionLifecycle(t *testing.T) {
	actors := []model.Principal{defaultHTTPPrincipal(), {UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	personal := []string{"e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"}
	tx := newHTTPTestStore(t)
	mcpOrgAuthenticate(t, tx, actors, tokens, personal, 8)
	production, _ := newMCPHTTPServer(t, tx)
	origin := production.URL
	clients := []*sdk.ClientSession{mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])}
	target := mcpOrgTeam(t, "a7777777-7777-4777-8777-777777777777", "Destination", actors[1].UserID)
	call := func(who int, name string, args map[string]any) (map[string]any, bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := clients[who].CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err = json.Unmarshal(encoded, &v); err != nil {
			t.Fatal(err)
		}
		return v, result.IsError
	}
	obj := func(v any) map[string]any {
		t.Helper()
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("expected object: %#v", v)
		}
		return m
	}
	prepareRepository := func(p model.Principal, name, repo string, v model.Project, matching bool) {
		t.Helper()
		read := projectHTTPCount(t, 1)
		mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
			read()
			projectHTTPCheck(t, actor, p)
			projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeAll})
			projectHTTPCheck(t, page, store.Page{Limit: 100})
			items := []model.Project{}
			if matching {
				items = []model.Project{v}
			}
			return store.ProjectPage{Items: items}, nil
		}}, nil)
		if matching {
			return
		}
		write, lock, member, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
		dao := projectHTTPCreateDAO{t: t, TeamCall: func(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
			lock()
			projectHTTPCheck(t, id, personal[0])
			return store.ProjectCreationTeam{ID: id}, nil
		}, MemberCall: func(ctx context.Context, id string) (bool, error) {
			member()
			projectHTTPCheck(t, id, personal[0])
			return true, nil
		}, InsertCall: func(ctx context.Context, id, gotName, gotRepo, team string) (model.Project, model.ProjectAccess, error) {
			insert()
			if _, err := model.CanonicalID(id); err != nil {
				t.Errorf("invalid allocated Project UUID: %v", err)
			}
			projectHTTPCheck(t, gotName, name)
			projectHTTPCheck(t, gotRepo, repo)
			projectHTTPCheck(t, team, personal[0])
			return v, projectHTTPAccess(p, v), nil
		}}
		tx.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
			write()
			projectHTTPCheck(t, user, p.UserID)
			err := op(dao)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		}
	}
	unicodeTeam := mcpOrgTeam(t, "b8888888-8888-4888-8888-888888888888", strings.Repeat("😀", 256), actors[0].UserID)
	mcpOrgCreateTeam(t, tx, actors[0], unicodeTeam)
	teamResponse, failed := call(0, "team_create", map[string]any{"name": *unicodeTeam.Name, "confirm": true})
	if failed || obj(teamResponse["data"])["id"] != unicodeTeam.ID {
		t.Fatalf("boundary Team: %+v", teamResponse)
	}
	teamID := unicodeTeam.ID
	asciiName := strings.Repeat("a", 256)
	mcpOrgCreateTeam(t, tx, actors[0], mcpOrgTeam(t, "c9999999-9999-4999-8999-999999999999", asciiName, actors[0].UserID))
	if response, failed := call(0, "team_create", map[string]any{"name": asciiName, "confirm": true}); failed {
		t.Fatalf("256-code-point Team: %+v", response)
	}
	asciiProject := projectHTTPRecord("d0000000-0000-4000-8000-000000000000", asciiName, "host:boundary", personal[0])
	prepareRepository(actors[0], asciiName, "host:boundary", asciiProject, false)
	if response, failed := call(0, "project_create", map[string]any{"name": asciiName, "repoUrl": "host:boundary", "team": "personal", "confirm": true}); failed {
		t.Fatalf("256-code-point Project: %+v", response)
	}
	prefix := "https://example.com/"
	maxURL := prefix + strings.Repeat("r", 4096-len(prefix))
	maxProject := projectHTTPRecord("e0000000-0000-4000-8000-000000000000", strings.Repeat("😀", 256), maxURL, personal[0])
	maxArgs := map[string]any{"name": maxProject.Name, "repoUrl": maxURL, "team": "personal", "confirm": true}
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, false)
	createdMax, failed := call(0, "project_create", maxArgs)
	if failed {
		t.Fatalf("boundary Project: %+v", createdMax)
	}
	maxID := obj(obj(createdMax["data"])["project"])["id"]
	delete(maxArgs, "confirm")
	prepareRepository(actors[0], maxProject.Name, maxURL, maxProject, true)
	reusedMax, failed := call(0, "project_create", maxArgs)
	if failed || obj(reusedMax["data"])["created"] != false || obj(obj(reusedMax["data"])["project"])["id"] != maxID {
		t.Fatalf("boundary repository reuse: %+v", reusedMax)
	}
	tx.ReadSnapshotCall = nil
	tx.CreateTeamCall = nil
	tx.WriteTeamCall = nil
	tx.WriteProjectCreationCall = nil
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		for _, request := range []struct {
			tool string
			args map[string]any
		}{{"team_create", map[string]any{"name": name, "confirm": true}}, {"team_rename", map[string]any{"team": teamID, "name": name, "ifVersion": "1", "confirm": true}}, {"project_create", map[string]any{"name": name, "repoUrl": "host:repo", "team": "personal", "confirm": true}}} {
			tx.ReadSnapshotCall = nil
			tx.WriteTeamCall = nil
			if request.tool == "team_rename" {
				read, readTeam := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
				mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(ctx context.Context, user, id string) (model.Team, error) {
					read()
					projectHTTPCheck(t, []string{user, id}, []string{actors[0].UserID, unicodeTeam.ID})
					return unicodeTeam, nil
				}})
				mcpOrgWriteTeam(t, tx, unicodeTeam.ID, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
					readTeam()
					projectHTTPCheck(t, user, actors[0].UserID)
					return unicodeTeam, nil
				}}, nil)
			}
			response, failed := call(0, request.tool, request.args)
			if !failed || obj(response["error"])["code"] != "invalid_input" {
				t.Fatalf("%s: %+v", request.tool, response)
			}
		}
	}
	response, failed := call(0, "project_create", map[string]any{"name": "Project", "repoUrl": maxURL + "r", "team": "personal", "confirm": true})
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("oversized repository: %+v", response)
	}
	project := projectHTTPRecord("f0000000-0000-4000-8000-000000000000", "Project", "https://github.com/acme/test.git", personal[0])
	args := map[string]any{"name": project.Name, "repoUrl": project.RepoURL, "team": "personal"}
	read := projectHTTPCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		read()
		projectHTTPCheck(t, actor, actors[0])
		projectHTTPCheck(t, scope, store.ProjectScope{Kind: store.ProjectScopeAll})
		projectHTTPCheck(t, page, store.Page{Limit: 100})
		return store.ProjectPage{Items: []model.Project{}}, nil
	}}, nil)
	response, failed = call(0, "project_create", args)
	if !failed || obj(response["error"])["code"] != "invalid_input" {
		t.Fatalf("confirmation: %+v", response)
	}
	args["confirm"] = true
	prepareRepository(actors[0], project.Name, project.RepoURL, project, false)
	response, failed = call(0, "project_create", args)
	if failed {
		t.Fatalf("create: %+v", response)
	}
	data := obj(response["data"])
	id := obj(data["project"])["id"].(string)
	if data["created"] != true || id != project.ID {
		t.Fatalf("create receipt: %+v", data)
	}
	prepareRepository(actors[0], "Different", "git@github.com:acme/test.git", project, true)
	response, failed = call(0, "project_create", map[string]any{"name": "Different", "repoUrl": "git@github.com:acme/test.git", "team": target.ID})
	if failed || obj(response["data"])["created"] != false || obj(obj(response["data"])["project"])["id"] != id {
		t.Fatalf("reuse: %+v", response)
	}
	preparePreview := func(actor model.Principal, accessErr error) {
		t.Helper()
		access := projectHTTPCount(t, 1)
		dao := mcpOrgProjectReader{ProjectAccessCall: func(ctx context.Context, got model.Principal, projectID string) (model.ProjectAccess, error) {
			access()
			projectHTTPCheck(t, got, actor)
			projectHTTPCheck(t, projectID, id)
			return projectHTTPAccess(actor, project), accessErr
		}}
		if accessErr == nil {
			team, role := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
			dao.TransferTeamCall = func(ctx context.Context, teamID string) (store.TransferTeam, error) {
				team()
				projectHTTPCheck(t, teamID, target.ID)
				return store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
			}
			dao.TransferRoleCall = func(ctx context.Context, user, projectID, teamID string) (*model.ProjectRole, error) {
				role()
				projectHTTPCheck(t, []string{user, projectID, teamID}, []string{actor.UserID, id, target.ID})
				return nil, nil
			}
		}
		mcpOrgRead(t, tx, 1, dao, nil)
	}
	preparePreview(actors[1], model.ErrNotFound)
	response, failed = call(1, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "confirm": true})
	if !failed {
		t.Fatalf("unauthorized transfer: %+v", response)
	}
	preparePreview(actors[0], nil)
	own, teams, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	mcpOrgWriteProject(t, tx, id, mcpOrgProjectWriter{LockTransferOwnershipCall: func(context.Context) (model.ProjectOwnership, error) { own(); return project.Ownership, nil }, LockTransferTeamsCall: func(ctx context.Context, source, dest string) (store.TransferTeam, store.TransferTeam, error) {
		teams()
		projectHTTPCheck(t, []string{source, dest}, []string{personal[0], target.ID})
		return store.TransferTeam{Ref: model.TeamRef{ID: personal[0], Kind: "personal"}, Version: 1}, store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
	}, ProjectAccessCall: func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, actors[0])
		return projectHTTPAccess(actor, project), nil
	}}, nil)
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": target.ID, "ifVersion": "999", "confirm": true})
	if !failed || obj(response["error"])["code"] != "version_conflict" {
		t.Fatalf("stale transfer: %+v", response)
	}
	preparePreview(actors[0], nil)
	own, teams, move, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 2)
	nextOwnership := model.ProjectOwnership{TeamID: target.ID, Version: 2, UpdatedAt: project.UpdatedAt.Add(time.Second)}
	accessCalls := 0
	mcpOrgWriteProject(t, tx, id, mcpOrgProjectWriter{LockTransferOwnershipCall: func(context.Context) (model.ProjectOwnership, error) { own(); return project.Ownership, nil }, LockTransferTeamsCall: func(ctx context.Context, source, dest string) (store.TransferTeam, store.TransferTeam, error) {
		teams()
		projectHTTPCheck(t, []string{source, dest}, []string{personal[0], target.ID})
		return store.TransferTeam{Ref: model.TeamRef{ID: personal[0], Kind: "personal"}, Version: 1}, store.TransferTeam{Ref: target.TeamRef, Version: 1}, nil
	}, MoveOwnershipCall: func(ctx context.Context, dest string) (model.ProjectOwnership, error) {
		move()
		projectHTTPCheck(t, dest, target.ID)
		return nextOwnership, nil
	}, ProjectAccessCall: func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, actors[0])
		accessCalls++
		if accessCalls == 1 {
			prior := projectHTTPAccess(actor, project)
			prior.DirectGrant = nil
			return prior, nil
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}}, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{ProjectID: id}))
	response, failed = call(0, "project_transfer", map[string]any{"projectId": id, "toTeam": origin + "/teams/" + target.ID, "confirm": true})
	if failed {
		t.Fatalf("transfer: %+v", response)
	}
	data = obj(response["data"])
	if data["changed"] != true || data["actorAccess"] != nil || obj(data["ownerTeam"])["id"] != target.ID || obj(data["ownership"])["version"] != "2" {
		t.Fatalf("transfer receipt: %+v", data)
	}
	mcpOrgGetProject(t, tx, actors[0], project, model.ErrNotFound)
	response, failed = call(0, "project_show", map[string]any{"projectId": id})
	if !failed || obj(response["error"])["code"] != "not_found" {
		t.Fatalf("lost access: %+v", response)
	}
	next := project
	next.Ownership = nextOwnership
	mcpOrgGetProject(t, tx, actors[1], next, nil)
	response, failed = call(1, "project_show", map[string]any{"projectId": id})
	if failed || obj(response["data"])["id"] != id {
		t.Fatalf("new owner read: %+v", response)
	}
}

func newMCPHTTPServer(t *testing.T, tx *httpTestStore, outputs ...io.Writer) (*httptest.Server, *Entry) {
	t.Helper()
	output := io.Writer(io.Discard)
	if len(outputs) > 1 {
		t.Fatal("MCP fixture accepts at most one log writer")
	}
	if len(outputs) == 1 {
		output = outputs[0]
	}
	identity := identityservice.New(tx, nil, "")
	projects := projectservice.NewProjects(tx)
	memberships := projectservice.NewMemberships(tx)
	teams := teamservice.NewTeams(tx)
	return newAdapterHost(t, identity, output, func(entry *Entry, origin string) error {
		if err := RegisterProjectTools(entry, projects, identity, origin); err != nil {
			return err
		}
		if err := RegisterTeamTools(entry, teams, projects, identity); err != nil {
			return err
		}
		return RegisterInvitationTools(entry, identity, teams, memberships, origin)
	})
}
func mcpPATClient(t *testing.T, address, token string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "mcp-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: address + "/mcp", HTTPClient: &http.Client{Transport: headerTransport{base: http.DefaultTransport, token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatalf("connect MCP: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func TestMCPOrganizationAdapterHostCatalog(t *testing.T) {
	tx := newHTTPTestStore(t)
	actor, token := defaultHTTPPrincipal(), defaultHTTPToken()
	mcpOrgAuthenticate(t, tx, []model.Principal{actor}, []string{token}, []string{"e1111111-1111-4111-8111-111111111111"}, 0)
	server, _ := newMCPHTTPServer(t, tx)
	client := mcpPATClient(t, server.URL, token)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	list, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"project_create": true, "project_transfer": true, "project_list": true, "project_resolve": true, "project_show": true,
		"team_create": true, "team_rename": true, "team_delete": true, "team_leave": true, "team_list": true, "team_show": true, "team_projects": true, "team_member_list": true, "team_member_set_role": true, "team_member_remove": true,
		"team_invitation_create": true, "team_invitation_list": true, "team_invitation_revoke": true, "invitation_inspect": true, "invitation_accept": true,
	}
	for _, tool := range list.Tools {
		if !want[tool.Name] {
			t.Errorf("unexpected or duplicate adapter tool %s", tool.Name)
		}
		delete(want, tool.Name)
	}
	for name := range want {
		t.Errorf("missing adapter tool %s", name)
	}
}
