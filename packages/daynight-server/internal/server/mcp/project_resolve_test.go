package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestProjectResolveForwardsContextAndMapsProject(t *testing.T) {
	ctx := t.Context()
	actor := projectActor()
	address := "git@example.com:Group/Repo.git"
	project := sampleProject(testProjectID)
	calls := 0
	ops := &fakeProjectOperations{resolve: func(got context.Context, principal model.Principal, input string) (model.Project, error) {
		calls++
		if got != ctx || principal != actor.Principal || input != address {
			t.Fatalf("resolve context/principal/address: %v %+v %q", got == ctx, principal, input)
		}
		return project, nil
	}}
	result, err := (&projectTools{projects: ops}).resolve(ctx, actor, projectResolveInput{RepoURL: address})
	if err != nil || calls != 1 || !reflect.DeepEqual(result.Data, MapProject(project)) || result.Outcome != "" || result.WriteOutcome != "" || result.Phase != "" || result.Refs != nil {
		t.Fatalf("result=%+v calls=%d err=%v", result, calls, err)
	}
}

func TestProjectResolveProtocol(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			f := newEntryFixture(t)
			var logs bytes.Buffer
			f.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
			project := sampleProject(testProjectID)
			project.CreatedAt = time.Date(2026, 11, 9, 12, 0, 0, 0, time.FixedZone("local", 8*60*60))
			project.UpdatedAt = project.CreatedAt.Add(time.Minute)
			project.Settings.ExecutionWarningMinutes = 17
			project.Ownership.UpdatedAt = project.CreatedAt.Add(2 * time.Minute)
			var calls int
			var seen string
			var failure error
			ops := &fakeProjectOperations{resolve: func(_ context.Context, principal model.Principal, address string) (model.Project, error) {
				calls++
				seen = address
				if principal.UserID != "alice" {
					t.Fatalf("principal=%+v", principal)
				}
				if failure != nil {
					return model.Project{}, failure
				}
				if _, err := coreproject.NewRepositoryMatch(address); err != nil {
					return model.Project{}, err
				}
				return project, nil
			}}
			if err := RegisterProjectTools(f.entry, ops, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, version, "alice")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			listing, err := client.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			var tool *sdk.Tool
			for _, candidate := range listing.Tools {
				if candidate.Name == "project_resolve" {
					tool = candidate
				}
			}
			if tool == nil || tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint || tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
				t.Fatalf("annotations: %+v", tool)
			}
			inputBytes, err := json.Marshal(tool.InputSchema)
			if err != nil {
				t.Fatal(err)
			}
			var schema map[string]any
			if err := json.Unmarshal(inputBytes, &schema); err != nil {
				t.Fatal(err)
			}
			if schema["additionalProperties"] != false || !requiredExactly(schema["required"], "repoUrl") || len(object(t, schema["properties"])) != 1 {
				t.Fatalf("input schema: %s", inputBytes)
			}
			call := func(args any) *sdk.CallToolResult {
				t.Helper()
				result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "project_resolve", Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			prefix := "https://example.com/"
			remaining := 4096 - len(prefix)
			address := prefix + strings.Repeat("é", remaining/2) + strings.Repeat("x", remaining%2)
			result := call(map[string]any{"repoUrl": address})
			doc := structured(t, result)
			data := object(t, doc["data"])
			want := map[string]any{
				"id": project.ID, "name": project.Name, "repoUrl": project.RepoURL,
				"createdAt": "2026-11-09T04:00:00Z", "updatedAt": "2026-11-09T04:01:00Z",
				"settings":  map[string]any{"version": "9007199254740993", "executionWarningMinutes": float64(17)},
				"ownership": map[string]any{"teamId": testTeamID, "version": "9007199254740994", "updatedAt": "2026-11-09T04:02:00Z"},
			}
			if result.IsError || seen != address || !reflect.DeepEqual(data, want) || object(t, doc["meta"])["outcome"] != nil {
				t.Fatalf("success: %+v", doc)
			}
			outputSchema, err := resolveSchema(tool.OutputSchema)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateJSON(outputSchema, encoded); err != nil {
				t.Fatalf("success does not satisfy advertised output schema: %v", err)
			}
			result = call(map[string]any{"repoUrl": address + "é"})
			if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
				t.Fatalf("byte limit: %+v", result)
			}
			before := calls
			for _, args := range []any{map[string]any{}, map[string]any{"repoUrl": "x", "extra": true}} {
				result = call(args)
				if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
					t.Fatalf("invalid schema: %+v", result)
				}
			}
			if calls != before {
				t.Fatalf("invalid schema reached use case: %d -> %d", before, calls)
			}
			for _, code := range []string{"not_found", "resource_conflict", "invalid_input"} {
				failure = &model.Fault{Code: code, Message: "refused"}
				result = call(map[string]any{"repoUrl": "https://example.com/repo"})
				doc = structured(t, result)
				e := object(t, doc["error"])
				if !result.IsError || e["code"] != code || e["writeOutcome"] != nil || doc["data"] != nil {
					t.Fatalf("%s: %+v", code, doc)
				}
			}
			failure = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("secret repository address")}
			result = call(map[string]any{"repoUrl": "https://example.com/private"})
			doc = structured(t, result)
			if e := object(t, doc["error"]); !result.IsError || e["code"] != "internal_error" || e["writeOutcome"] != nil || doc["data"] != nil {
				t.Fatalf("snapshot failure: %+v", doc)
			}
			if strings.Contains(logs.String(), "example.com/private") || strings.Contains(logs.String(), "secret repository address") || !strings.Contains(logs.String(), `"operation":"project_resolve"`) || !strings.Contains(logs.String(), `"phase":"tool_call"`) || !strings.Contains(logs.String(), `"request_id":"test-request"`) {
				t.Fatalf("unsafe or incomplete logs: %s", logs.String())
			}
			failure = nil
			release, err := f.entry.budget.Acquire(ctx, BudgetLarge)
			if err != nil {
				t.Fatal(err)
			}
			before = calls
			result = call(map[string]any{"repoUrl": "https://example.com/repo"})
			if !result.IsError || object(t, structured(t, result)["error"])["code"] != "resource_busy" || calls != before {
				t.Fatalf("admission: %+v calls=%d", result, calls)
			}
			release()
			result = call(map[string]any{"repoUrl": "https://example.com/repo"})
			if result.IsError || calls != before+1 {
				t.Fatalf("budget not released: %+v", result)
			}
		})
	}
}

func TestCanceledProjectResolveHoldsLargeBudgetUntilCallbackAndHTTPFinish(t *testing.T) {
	entered, canceled, releaseHandler, exited := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	httpDone := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(releaseHandler) }) }
	var calls atomic.Int64
	ops := &fakeProjectOperations{resolve: func(ctx context.Context, _ model.Principal, _ string) (model.Project, error) {
		if calls.Add(1) == 1 {
			defer close(exited)
			close(entered)
			<-ctx.Done()
			close(canceled)
			<-releaseHandler
			return model.Project{}, ctx.Err()
		}
		return sampleProject(testProjectID), nil
	}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjectTools(entry, ops, nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server := httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-ID") == "cancel-resolve" {
			defer close(httpDone)
		}
		entry.ServeHTTP(w, r)
	})))
	t.Cleanup(server.Close)
	t.Cleanup(unblock)
	call := func(ctx context.Context, requestID string) (materializationResult, error) {
		var result materializationResult
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_resolve","arguments":{"repoUrl":"https://example.com/repo"}}}`
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(body))
		if err != nil {
			return result, err
		}
		req.Header.Set("Authorization", "Bearer alice")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		req.Header.Set("X-Request-ID", requestID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return result, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return result, errors.New("unexpected HTTP status")
		}
		err = json.NewDecoder(resp.Body).Decode(&result)
		return result, err
	}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan error, 1)
	go func() { _, err := call(firstCtx, "cancel-resolve"); firstDone <- err }()
	waitMaterialization(t, entered, "resolve callback")
	cancelFirst()
	waitMaterialization(t, canceled, "resolve cancellation")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	busy, err := call(ctx, "resolve-busy")
	if err != nil || !busy.Result.IsError || busy.Result.StructuredContent.Error.Code != "resource_busy" || calls.Load() != 1 {
		t.Fatalf("canceled callback did not retain Large permit: %+v calls=%d err=%v", busy, calls.Load(), err)
	}
	unblock()
	waitMaterialization(t, exited, "resolve callback exit")
	waitMaterialization(t, httpDone, "canceled resolve HTTP completion")
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled client did not finish")
	}
	after, err := call(ctx, "resolve-after")
	if err != nil || after.Result.IsError || after.Result.StructuredContent.Data["id"] != testProjectID || calls.Load() != 2 {
		t.Fatalf("Large permit not released after callback and HTTP: %+v calls=%d err=%v", after, calls.Load(), err)
	}
}

func TestMCPOutputConstructionFailureLog(t *testing.T) {
	f := newEntryFixture(t)
	var logs bytes.Buffer
	f.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	client := f.client(t, "2026-07-28", "alice")
	result, err := callTest(t, client, map[string]any{"mode": "bad_output"})
	if err != nil || !result.IsError {
		t.Fatalf("output failure: %+v %v", result, err)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &record); err != nil {
		t.Fatalf("output log %q: %v", logs.String(), err)
	}
	for key, want := range map[string]string{"type": "operation_error", "component": "mcp", "operation": "test_only", "phase": "output", "cause": "output_invalid", "error_code": "internal_error", "request_id": "test-request"} {
		if record[key] != want {
			t.Fatalf("output log %s = %v; want %s", key, record[key], want)
		}
	}
}

type mcpOrgProjectReader struct {
	t *testing.T
	store.ProjectReader
	ScopedProjectsCall func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error)
	ProjectCall        func(ctx context.Context, id string) (model.Project, error)
	ProjectAccessCall  func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error)
	TransferTeamCall   func(ctx context.Context, id string) (store.TransferTeam, error)
	TransferRoleCall   func(ctx context.Context, user, project, team string) (*model.ProjectRole, error)
	InvitationCall     func(ctx context.Context, hash []byte) (model.ProjectInvitation, error)
}

func (d mcpOrgProjectReader) ScopedProjects(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	return requireCallback(d.t, "MCP DAO ScopedProjectsCall", d.ScopedProjectsCall)(ctx, actor, scope, page)
}
func (d mcpOrgProjectReader) Project(ctx context.Context, id string) (model.Project, error) {
	return requireCallback(d.t, "MCP DAO ProjectCall", d.ProjectCall)(ctx, id)
}
func (d mcpOrgProjectReader) ProjectAccess(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
	return requireCallback(d.t, "MCP DAO ProjectAccessCall", d.ProjectAccessCall)(ctx, actor, id)
}
func (d mcpOrgProjectReader) TransferTeam(ctx context.Context, id string) (store.TransferTeam, error) {
	return requireCallback(d.t, "MCP DAO TransferTeamCall", d.TransferTeamCall)(ctx, id)
}
func (d mcpOrgProjectReader) TransferRole(ctx context.Context, user, project, team string) (*model.ProjectRole, error) {
	return requireCallback(d.t, "MCP DAO TransferRoleCall", d.TransferRoleCall)(ctx, user, project, team)
}
func (d mcpOrgProjectReader) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	return requireCallback(d.t, "MCP DAO InvitationCall", d.InvitationCall)(ctx, hash)
}

type mcpOrgTeamReader struct {
	t                   *testing.T
	TeamAccessCall      func(ctx context.Context, user, id string) error
	TeamMembersPageCall func(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error)

	store.TeamReader
	TeamCall                 func(ctx context.Context, user, id string) (model.Team, error)
	TeamInvitationCall       func(ctx context.Context, hash []byte) (model.TeamInvitation, error)
	TeamInvitationPageCall   func(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error)
	InvitationTeamCall       func(ctx context.Context, id string) (model.TeamRef, error)
	InvitationTeamMemberCall func(ctx context.Context, id, user string) (model.TeamMember, error)
}

func (d mcpOrgTeamReader) Team(ctx context.Context, user, id string) (model.Team, error) {
	return requireCallback(d.t, "MCP DAO TeamCall", d.TeamCall)(ctx, user, id)
}
func (d mcpOrgTeamReader) TeamInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	return requireCallback(d.t, "MCP DAO TeamInvitationCall", d.TeamInvitationCall)(ctx, hash)
}
func (d mcpOrgTeamReader) TeamInvitationPage(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
	return requireCallback(d.t, "MCP DAO TeamInvitationPageCall", d.TeamInvitationPageCall)(ctx, id, now, page)
}
func (d mcpOrgTeamReader) InvitationTeam(ctx context.Context, id string) (model.TeamRef, error) {
	return requireCallback(d.t, "MCP DAO InvitationTeamCall", d.InvitationTeamCall)(ctx, id)
}
func (d mcpOrgTeamReader) InvitationTeamMember(ctx context.Context, id, user string) (model.TeamMember, error) {
	return requireCallback(d.t, "MCP DAO InvitationTeamMemberCall", d.InvitationTeamMemberCall)(ctx, id, user)
}

type mcpOrgTeamWriter struct {
	t                 *testing.T
	RenameCall        func(ctx context.Context, user, name string) (model.Team, error)
	HasProjectsCall   func(ctx context.Context) (bool, error)
	MemberCall        func(ctx context.Context, user string) (model.TeamMember, error)
	AdminCountCall    func(ctx context.Context) (int64, error)
	SetMemberRoleCall func(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error)
	RemoveMemberCall  func(ctx context.Context, user string) error

	store.TeamWriteDAO
	TeamCall              func(ctx context.Context, user string) (model.Team, error)
	CreateInvitationCall  func(ctx context.Context, invitation model.TeamInvitation) error
	LockInvitationCall    func(ctx context.Context, hash []byte) (model.TeamInvitation, error)
	InvitationTeamCall    func(ctx context.Context) (model.TeamRef, error)
	InvitationMemberCall  func(ctx context.Context, user string) (model.TeamMember, error)
	AddInvitedMemberCall  func(ctx context.Context, user string) (model.TeamMember, error)
	ConsumeInvitationCall func(ctx context.Context, id, user string, now time.Time) error
	RevokeInvitationCall  func(ctx context.Context, id string, now time.Time) (bool, error)
}

func (d mcpOrgTeamWriter) Team(ctx context.Context, user string) (model.Team, error) {
	return requireCallback(d.t, "MCP DAO TeamCall", d.TeamCall)(ctx, user)
}
func (d mcpOrgTeamWriter) CreateInvitation(ctx context.Context, invitation model.TeamInvitation) error {
	return requireCallback(d.t, "MCP DAO CreateInvitationCall", d.CreateInvitationCall)(ctx, invitation)
}
func (d mcpOrgTeamWriter) LockInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	return requireCallback(d.t, "MCP DAO LockInvitationCall", d.LockInvitationCall)(ctx, hash)
}
func (d mcpOrgTeamWriter) InvitationTeam(ctx context.Context) (model.TeamRef, error) {
	return requireCallback(d.t, "MCP DAO InvitationTeamCall", d.InvitationTeamCall)(ctx)
}
func (d mcpOrgTeamWriter) InvitationMember(ctx context.Context, user string) (model.TeamMember, error) {
	return requireCallback(d.t, "MCP DAO InvitationMemberCall", d.InvitationMemberCall)(ctx, user)
}
func (d mcpOrgTeamWriter) AddInvitedMember(ctx context.Context, user string) (model.TeamMember, error) {
	return requireCallback(d.t, "MCP DAO AddInvitedMemberCall", d.AddInvitedMemberCall)(ctx, user)
}
func (d mcpOrgTeamWriter) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	return requireCallback(d.t, "MCP DAO ConsumeInvitationCall", d.ConsumeInvitationCall)(ctx, id, user, now)
}
func (d mcpOrgTeamWriter) RevokeInvitation(ctx context.Context, id string, now time.Time) (bool, error) {
	return requireCallback(d.t, "MCP DAO RevokeInvitationCall", d.RevokeInvitationCall)(ctx, id, now)
}

type mcpOrgProjectWriter struct {
	t *testing.T
	store.ProjectWriteDAO
	ProjectAccessCall         func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error)
	LockTransferOwnershipCall func(ctx context.Context) (model.ProjectOwnership, error)
	LockTransferTeamsCall     func(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error)
	MoveOwnershipCall         func(ctx context.Context, target string) (model.ProjectOwnership, error)
	LockInvitationCall        func(ctx context.Context, hash []byte) (model.ProjectInvitation, error)
	DirectProjectMemberCall   func(ctx context.Context, user string) (model.ProjectMember, error)
	AddInvitedMemberCall      func(ctx context.Context, user string) (model.ProjectMember, error)
	ConsumeInvitationCall     func(ctx context.Context, id, user string, now time.Time) error
}

func (d mcpOrgProjectWriter) ProjectAccess(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
	return requireCallback(d.t, "MCP DAO ProjectAccessCall", d.ProjectAccessCall)(ctx, actor)
}
func (d mcpOrgProjectWriter) LockTransferOwnership(ctx context.Context) (model.ProjectOwnership, error) {
	return requireCallback(d.t, "MCP DAO LockTransferOwnershipCall", d.LockTransferOwnershipCall)(ctx)
}
func (d mcpOrgProjectWriter) LockTransferTeams(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error) {
	return requireCallback(d.t, "MCP DAO LockTransferTeamsCall", d.LockTransferTeamsCall)(ctx, source, target)
}
func (d mcpOrgProjectWriter) MoveOwnership(ctx context.Context, target string) (model.ProjectOwnership, error) {
	return requireCallback(d.t, "MCP DAO MoveOwnershipCall", d.MoveOwnershipCall)(ctx, target)
}
func (d mcpOrgProjectWriter) LockInvitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	return requireCallback(d.t, "MCP DAO LockInvitationCall", d.LockInvitationCall)(ctx, hash)
}
func (d mcpOrgProjectWriter) DirectProjectMember(ctx context.Context, user string) (model.ProjectMember, error) {
	return requireCallback(d.t, "MCP DAO DirectProjectMemberCall", d.DirectProjectMemberCall)(ctx, user)
}
func (d mcpOrgProjectWriter) AddInvitedMember(ctx context.Context, user string) (model.ProjectMember, error) {
	return requireCallback(d.t, "MCP DAO AddInvitedMemberCall", d.AddInvitedMemberCall)(ctx, user)
}
func (d mcpOrgProjectWriter) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	return requireCallback(d.t, "MCP DAO ConsumeInvitationCall", d.ConsumeInvitationCall)(ctx, id, user, now)
}

type mcpOrgTeamScope struct {
	t *testing.T
	store.TeamWriteScope
	team        store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s mcpOrgTeamScope) TeamDAO() store.TeamWriteDAO {
	if s.team == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.TeamDAO")
	}
	return s.team
}
func (s mcpOrgTeamScope) EligibilityDAO() store.WebhookEligibilityDAO {
	if s.eligibility == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.EligibilityDAO")
	}
	return s.eligibility
}

type mcpOrgProjectScope struct {
	t *testing.T
	store.ProjectWriteScope
	project     store.ProjectWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s mcpOrgProjectScope) ProjectDAO() store.ProjectWriteDAO {
	if s.project == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.ProjectDAO")
	}
	return s.project
}
func (s mcpOrgProjectScope) EligibilityDAO() store.WebhookEligibilityDAO {
	if s.eligibility == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.EligibilityDAO")
	}
	return s.eligibility
}
func mcpOrgRead(t *testing.T, tx *httpTestStore, n int, project store.ProjectReader, team store.TeamReader) {
	switch d := project.(type) {
	case mcpOrgProjectReader:
		d.t = t
		project = d
	}
	switch d := team.(type) {
	case mcpOrgTeamReader:
		d.t = t
		team = d
	}
	called := mcpOrgCount(t, n)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		called()
		scope := newHTTPTestSnapshot(t)
		scope.Projects = project
		scope.Teams = team
		return op(scope)
	}
}

// Each scope callback has its own transaction count and checks the target ID.
func mcpOrgWrite[S any](t *testing.T, id string, scope S) func(context.Context, string, func(S) error) (store.Completion, error) {
	called := mcpOrgCount(t, 1)
	return func(_ context.Context, got string, op func(S) error) (store.Completion, error) {
		called()
		projectHTTPCheck(t, got, id)
		if err := op(scope); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}
func mcpOrgWriteTeam(t *testing.T, tx *httpTestStore, id string, dao store.TeamWriteDAO, eligibility store.WebhookEligibilityDAO) {
	if d, ok := dao.(mcpOrgTeamWriter); ok {
		d.t = t
		dao = d
	}
	tx.WriteTeamCall = mcpOrgWrite[store.TeamWriteScope](t, id, mcpOrgTeamScope{t: t, team: dao, eligibility: eligibility})
}
func mcpOrgWriteProject(t *testing.T, tx *httpTestStore, id string, dao store.ProjectWriteDAO, eligibility store.WebhookEligibilityDAO) {
	if d, ok := dao.(mcpOrgProjectWriter); ok {
		d.t = t
		dao = d
	}
	tx.WriteProjectCall = mcpOrgWrite[store.ProjectWriteScope](t, id, mcpOrgProjectScope{t: t, project: dao, eligibility: eligibility})
}

type httpTestStore struct {
	t                        *testing.T
	ReadSnapshotCall         func(context.Context, func(store.SnapshotScope) error) error
	WriteIdentityCall        func(context.Context, func(store.IdentityScope) error) (store.Completion, error)
	WriteProjectCall         func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
	WriteProjectCreationCall func(context.Context, string, func(store.ProjectCreationDAO) error) (store.Completion, error)
	CreateTeamCall           func(context.Context, string, func(store.TeamCreationDAO) error) (store.Completion, error)
	WriteTeamCall            func(context.Context, string, func(store.TeamWriteScope) error) (store.Completion, error)
}

func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }
func (s *httpTestStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, fn)
}
func (s *httpTestStore) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	if s.WriteIdentityCall == nil {
		unexpectedHTTPCall(s.t, "WriteIdentity")
	}
	return s.WriteIdentityCall(ctx, fn)
}
func (s *httpTestStore) WriteProject(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
	if s.WriteProjectCall == nil {
		unexpectedHTTPCall(s.t, "WriteProject")
	}
	return s.WriteProjectCall(ctx, id, fn)
}
func (s *httpTestStore) WriteProjectCreation(ctx context.Context, id string, fn func(store.ProjectCreationDAO) error) (store.Completion, error) {
	if s.WriteProjectCreationCall == nil {
		unexpectedHTTPCall(s.t, "WriteProjectCreation")
	}
	return s.WriteProjectCreationCall(ctx, id, fn)
}
func (s *httpTestStore) CreateTeam(ctx context.Context, id string, fn func(store.TeamCreationDAO) error) (store.Completion, error) {
	if s.CreateTeamCall == nil {
		unexpectedHTTPCall(s.t, "CreateTeam")
	}
	return s.CreateTeamCall(ctx, id, fn)
}
func (s *httpTestStore) WriteTeam(ctx context.Context, id string, fn func(store.TeamWriteScope) error) (store.Completion, error) {
	if s.WriteTeamCall == nil {
		unexpectedHTTPCall(s.t, "WriteTeam")
	}
	return s.WriteTeamCall(ctx, id, fn)
}

type httpTestSnapshot struct {
	store.SnapshotScope
	t        *testing.T
	Projects store.ProjectReader
	Teams    store.TeamReader
}

func newHTTPTestSnapshot(t *testing.T) *httpTestSnapshot { return &httpTestSnapshot{t: t} }
func (s *httpTestSnapshot) ProjectDAO() store.ProjectReader {
	if s.Projects == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.ProjectDAO")
	}
	return s.Projects
}
func (s *httpTestSnapshot) TeamDAO() store.TeamReader {
	if s.Teams == nil {
		unexpectedHTTPCall(s.t, "SnapshotScope.TeamDAO")
	}
	return s.Teams
}

type httpAuthenticationScope struct {
	store.IdentityScope
	t   *testing.T
	dao store.IdentityDAO
}

func (s httpAuthenticationScope) IdentityDAO() store.IdentityDAO { return s.dao }
func (s httpAuthenticationScope) PersonalTeamDAO() store.PersonalTeamDAO {
	unexpectedHTTPCall(s.t, "IdentityScope.PersonalTeamDAO")
	return nil
}
func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}
func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}
func defaultHTTPToken() string { return "dnpat_" + strings.Repeat("A", 43) }

type projectHTTPCreateDAO struct {
	t *testing.T
	store.ProjectCreationDAO
	TeamCall   func(context.Context, string) (store.ProjectCreationTeam, error)
	MemberCall func(context.Context, string) (bool, error)
	InsertCall func(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error)
}

func (d projectHTTPCreateDAO) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	return requireCallback(d.t, "ProjectCreation.LockCreationTeam", d.TeamCall)(ctx, id)
}
func (d projectHTTPCreateDAO) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	return requireCallback(d.t, "ProjectCreation.CreationTeamMember", d.MemberCall)(ctx, id)
}
func (d projectHTTPCreateDAO) InsertProject(ctx context.Context, id, name, repo, team string) (model.Project, model.ProjectAccess, error) {
	return requireCallback(d.t, "ProjectCreation.InsertProject", d.InsertCall)(ctx, id, name, repo, team)
}
func projectHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected DAO argument/result: got %#v, want %#v", got, want)
		panic("DAO contract violated")
	}
}
func projectHTTPCount(t *testing.T, want int) func() { return mcpOrgCount(t, want) }
func projectHTTPRecord(id, name, repo, team string) model.Project {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Project{ID: id, Name: name, RepoURL: repo, CreatedAt: at, UpdatedAt: at, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, Ownership: model.ProjectOwnership{TeamID: team, Version: 1, UpdatedAt: at}}
}
func projectHTTPAccess(p model.Principal, v model.Project) model.ProjectAccess {
	role := model.ProjectAdmin
	grant := model.ProjectGrant{ProjectID: v.ID, UserID: p.UserID, Role: role, Version: 1, CreatedAt: v.CreatedAt, UpdatedAt: v.CreatedAt}
	return model.ProjectAccess{ProjectID: v.ID, UserID: p.UserID, Role: role, DirectGrant: &grant, OwnerTeam: model.TeamRef{ID: v.Ownership.TeamID, Kind: "personal"}, Ownership: v.Ownership, TeamRole: &role, CanTransfer: true}
}

func (d projectHTTPCreateDAO) CreationPersonalTeam(context.Context, bool) (store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "ProjectCreation.CreationPersonalTeam")
	return store.PersonalTeamFacts{}, nil
}

// requireCallback makes an unconfigured DAO capability fail its owning test,
// including when the MCP server handles the call on another goroutine.
func requireCallback[T any](t *testing.T, name string, callback T) T {
	t.Helper()
	if reflect.ValueOf(callback).IsNil() {
		unexpectedHTTPCall(t, name)
	}
	return callback
}
