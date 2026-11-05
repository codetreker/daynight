package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

func TestCreateAndGetProject(t *testing.T) {
	projects, _, _, principal := projectService(t)
	ctx := context.Background()
	input := CreateProject{ExpectedUserID: principal.UserID, Name: "  Application project  ", RepoURL: "ssh://git@Git.Example:2222/Team/Application.git"}
	first, err := projects.Create(ctx, principal, input)
	if err != nil {
		t.Fatal(err)
	}
	id, err := uuid.Parse(first.ID)
	if err != nil || id.Version() != 4 || first.Name != input.Name || first.RepoURL != input.RepoURL || first.CreatedAt.IsZero() || !first.CreatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("created project: %#v, %v", first, err)
	}
	got, err := projects.Get(ctx, principal, strings.ToUpper(first.ID))
	if err != nil || !reflect.DeepEqual(got, first) {
		t.Fatalf("read canonical ID: %#v, %v", got, err)
	}
	second, err := projects.Create(ctx, principal, input)
	if err != nil || second.ID == first.ID {
		t.Fatalf("same repository must support independent projects: %#v, %v", second, err)
	}
	_, err = projects.Get(ctx, principal, "00000000-0000-0000-0000-000000000000")
	fault := requireFault(t, err, "not_found")
	if !errors.Is(fault, model.ErrNotFound) || fault.TaskIDs != nil || fault.Unwrap() == nil {
		t.Fatalf("missing original not-found cause: %#v", fault)
	}
}

func TestCanonicalID(t *testing.T) {
	_, _, _, principal := projectService(t)
	for _, value := range []string{"00000000-0000-0000-0000-000000000000", "F47AC10B-58CC-11CF-A447-001122334455", "f47ac10b-58cc-71cf-a447-001122334455"} {
		got, err := CanonicalID(value)
		if err != nil || got != strings.ToLower(value) {
			t.Fatalf("canonical %q: %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"", "f47ac10b58cc11cfa447001122334455", "{f47ac10b-58cc-11cf-a447-001122334455}", "urn:uuid:f47ac10b-58cc-11cf-a447-001122334455", "f47ac10b_58cc-11cf-a447-001122334455", "f47ac10b-58cc_11cf-a447-001122334455", "f47ac10b-58cc-11cf_a447-001122334455", "f47ac10b-58cc-11cf-a447_001122334455", "z47ac10b-58cc-11cf-a447-001122334455"} {
		_, err := CanonicalID(value)
		requireFault(t, err, "invalid_input")
		_, err = NewProjects(nil).Get(context.Background(), principal, value)
		requireFault(t, err, "invalid_input")
	}
}

type entropyFailure struct{ err error }

func (r entropyFailure) Read([]byte) (int, error) { return 0, r.err }

func TestCreateValidationAndEntropyFailure(t *testing.T) {
	_, _, _, principal := projectService(t)
	projects := NewProjects(nil)
	for _, name := range []string{"", " \t\n\u2003", "bad\x00name", "bad\xffname"} {
		_, err := projects.Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: name, RepoURL: "https://example.com/repo"})
		requireFault(t, err, "invalid_input")
	}
	_, err := projects.Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Project", RepoURL: "https://secret-token@example.com/repo"})
	requireFault(t, err, "invalid_input")
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatal("validation disclosed input credentials")
	}
	sentinel := errors.New("entropy unavailable")
	uuid.SetRand(entropyFailure{sentinel})
	t.Cleanup(func() { uuid.SetRand(rand.Reader) })
	_, err = projects.Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Project", RepoURL: "https://example.com/repo"})
	var fault *model.Fault
	if !errors.Is(err, sentinel) || errors.As(err, &fault) {
		t.Fatalf("entropy failure must retain operational cause: %v", err)
	}
}

func TestProjectStoreFailuresRemainOperational(t *testing.T) {
	projects, database, _, principal := projectService(t)
	database.Close()
	ctx := context.Background()
	_, createErr := projects.Create(ctx, principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Project", RepoURL: "https://example.com/repo"})
	_, getErr := projects.Get(ctx, principal, "00000000-0000-0000-0000-000000000001")
	_, listErr := projects.List(ctx, principal, model.PageRequest{Limit: 50})
	for _, err := range []error{createErr, getErr, listErr} {
		var fault *model.Fault
		var databaseError *store.Error
		if err == nil || errors.As(err, &fault) || !errors.As(err, &databaseError) {
			t.Fatalf("database error was masked: %#v", err)
		}
	}
}

func TestProjectSnapshotQueryFailuresRemainOperational(t *testing.T) {
	projects, database, _, principal := projectService(t)
	if _, err := database.Pool.Exec(context.Background(), "DROP TABLE projects"); err != nil {
		t.Fatal(err)
	}
	_, getErr := projects.Get(context.Background(), principal, "00000000-0000-0000-0000-000000000001")
	_, listErr := projects.List(context.Background(), principal, model.PageRequest{Limit: 50})
	for _, err := range []error{getErr, listErr} {
		var fault *model.Fault
		var pgError *pgconn.PgError
		if err == nil || errors.As(err, &fault) || !errors.As(err, &pgError) || pgError.Code != "42P01" {
			t.Fatalf("query error was masked: %#v", err)
		}
	}
}

func TestProjectPagination(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	empty, err := projects.List(ctx, principal, model.PageRequest{Limit: 1})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty page: %#v, %v", empty, err)
	}
	timestamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	for _, number := range []int{3, 1, 4, 2} {
		id := fmt.Sprintf("00000000-0000-0000-0000-%012d", number)
		if _, err := database.CreatePrivateProject(ctx, principal, id, fmt.Sprint(number), "host:repo"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE projects SET created_at = $1", timestamp); err != nil {
		t.Fatal(err)
	}
	var names []string
	request := model.PageRequest{Limit: 2}
	for pageNumber := 0; pageNumber < 2; pageNumber++ {
		page, err := projects.List(ctx, principal, request)
		if err != nil || len(page.Items) != 2 {
			t.Fatalf("page %d: %#v, %v", pageNumber, page, err)
		}
		for _, project := range page.Items {
			names = append(names, project.Name)
		}
		if pageNumber == 0 {
			if page.NextCursor == nil {
				t.Fatal("missing next cursor")
			}
			position, err := projectListPage(model.PageRequest{Limit: 2, Cursor: page.NextCursor}, principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
			if err != nil || !position.After.CreatedAt.Equal(timestamp) || position.After.ID != page.Items[1].ID {
				t.Fatalf("cursor must encode exact last position: %#v, %v", position, err)
			}
			request.Cursor = page.NextCursor
		} else if page.NextCursor != nil {
			t.Fatal("exact final page must have null cursor")
		}
	}
	if !reflect.DeepEqual(names, []string{"1", "2", "3", "4"}) {
		t.Fatalf("keyset order: %v", names)
	}
	page, err := projects.List(ctx, principal, model.PageRequest{Limit: 100})
	if err != nil || len(page.Items) != 4 || page.NextCursor != nil {
		t.Fatalf("all projects: %#v, %v", page, err)
	}
}

func TestProjectScopedPaginationAndValidation(t *testing.T) {
	projects, database, _, owner := projectService(t)
	ctx := context.Background()
	outsider := servicePrincipal(t, database)
	var created []model.Project
	for i := 0; i < 3; i++ {
		project, err := projects.Create(ctx, owner, CreateProject{ExpectedUserID: owner.UserID, Name: fmt.Sprintf("Project %d", i), RepoURL: "https://example.com/repo"})
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, project)
		if _, err := database.Pool.Exec(ctx, `UPDATE projects SET created_at='2024-01-01 00:00:00+00'::timestamptz + $2::int * interval '1 second' WHERE id=$1`, project.ID, i); err != nil {
			t.Fatal(err)
		}
		if i < 2 {
			if _, err := database.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, outsider.UserID); err != nil {
				t.Fatal(err)
			}
		}
	}
	teamID := created[0].Ownership.TeamID
	upperTeamID := strings.ToUpper(teamID)
	team := ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: &upperTeamID}
	first, err := projects.ListScoped(ctx, owner, team)
	if err != nil || len(first.Items) != 1 || first.Items[0].ID != created[0].ID || first.NextCursor == nil {
		t.Fatalf("first Team page: %#v %v", first, err)
	}
	team.TeamID = &teamID
	team.Page.Cursor = first.NextCursor
	second, err := projects.ListScoped(ctx, owner, team)
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != created[1].ID || second.NextCursor == nil {
		t.Fatalf("second Team page: %#v %v", second, err)
	}
	team.Page.Cursor = second.NextCursor
	last, err := projects.ListScoped(ctx, owner, team)
	if err != nil || len(last.Items) != 1 || last.Items[0].ID != created[2].ID || last.NextCursor != nil {
		t.Fatalf("last Team page: %#v %v", last, err)
	}
	shared := ProjectListRequest{Page: model.PageRequest{Limit: 1}, Shared: true}
	sharedFirst, err := projects.ListScoped(ctx, outsider, shared)
	if err != nil || len(sharedFirst.Items) != 1 || sharedFirst.Items[0].ID != created[0].ID || sharedFirst.NextCursor == nil {
		t.Fatalf("first shared page: %#v %v", sharedFirst, err)
	}
	shared.Page.Cursor = sharedFirst.NextCursor
	sharedLast, err := projects.ListScoped(ctx, outsider, shared)
	if err != nil || len(sharedLast.Items) != 1 || sharedLast.Items[0].ID != created[1].ID || sharedLast.NextCursor != nil {
		t.Fatalf("last shared page: %#v %v", sharedLast, err)
	}

	for _, request := range []ProjectListRequest{
		{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}},
		{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}, Shared: true},
		{Page: model.PageRequest{Limit: 1, Cursor: sharedFirst.NextCursor}, TeamID: &teamID},
		{Page: model.PageRequest{Limit: 1}, TeamID: &teamID, Shared: true},
		{Page: model.PageRequest{Limit: 1}, TeamID: pointer("")},
		{Page: model.PageRequest{Limit: 1}, TeamID: pointer("not-a-uuid")},
	} {
		_, err := projects.ListScoped(ctx, owner, request)
		requireFault(t, err, "invalid_input")
	}
	_, err = projects.ListScoped(ctx, outsider, ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: first.NextCursor}, TeamID: &teamID})
	requireFault(t, err, "invalid_input")
	_, err = projects.ListScoped(ctx, outsider, ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: &teamID})
	fault := requireFault(t, err, "not_found")
	if !errors.Is(fault, model.ErrNotFound) {
		t.Fatalf("Team refusal must retain cause: %v", fault)
	}
	if _, err := database.Pool.Exec(ctx, "DROP TABLE team_members"); err != nil {
		t.Fatal(err)
	}
	_, err = projects.ListScoped(ctx, owner, ProjectListRequest{Page: model.PageRequest{Limit: 1}, TeamID: &teamID})
	var operational *store.Error
	var domain *model.Fault
	if err == nil || !errors.As(err, &operational) || errors.As(err, &domain) {
		t.Fatalf("Team membership query failure must remain operational: %v", err)
	}
}

func TestProjectCursorEncodingFailureIsOperational(t *testing.T) {
	projects, database, _, principal := projectService(t)
	for _, number := range []int{1, 2} {
		if _, err := database.CreatePrivateProject(context.Background(), principal, fmt.Sprintf("00000000-0000-0000-0000-%012d", number), "Future", "host:repo"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE projects SET created_at = '10000-01-01'::timestamptz"); err != nil {
		t.Fatal(err)
	}
	_, err := projects.List(context.Background(), principal, model.PageRequest{Limit: 1})
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !strings.Contains(err.Error(), "encode project cursor") {
		t.Fatalf("unrepresentable cursor must fail: %#v", err)
	}
}

func cursorJSON(t *testing.T, cursor listCursor) string {
	t.Helper()
	data, err := json.Marshal(cursor)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func TestProjectListRejectsInvalidRequests(t *testing.T) {
	_, _, _, principal := projectService(t)
	for _, limit := range []int{-1, 0, 101} {
		_, err := NewProjects(nil).List(context.Background(), principal, model.PageRequest{Limit: limit})
		requireFault(t, err, "invalid_input")
	}
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	valid := projectCursor{Version: 2, Kind: "scoped-projects", UserID: principal.UserID, Scope: scope.Kind, CreatedAt: time.Now().UTC(), ID: "f47ac10b-58cc-11cf-a447-001122334455"}
	encode := func(value projectCursor) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	validEncoded := encode(valid)
	if _, err := projectListPage(model.PageRequest{Limit: 50, Cursor: &validEncoded}, principal.UserID, scope); err != nil {
		t.Fatal(err)
	}
	var invalid []string
	for _, mutate := range []func(*projectCursor){
		func(c *projectCursor) { c.Version = 1 },
		func(c *projectCursor) { c.Kind = "projects" },
		func(c *projectCursor) { c.UserID = uuid.NewString() },
		func(c *projectCursor) { c.Scope = store.ProjectScopeShared },
		func(c *projectCursor) { c.TeamID = uuid.NewString() },
		func(c *projectCursor) { c.CreatedAt = time.Time{} },
		func(c *projectCursor) { c.ID = "bad-id" },
		func(c *projectCursor) { c.ID = strings.ToUpper(c.ID) },
	} {
		cursor := valid
		mutate(&cursor)
		invalid = append(invalid, encode(cursor))
	}
	invalid = append(invalid, cursorJSON(t, listCursor{Version: 1, Kind: "projects", CreatedAt: valid.CreatedAt, ID: valid.ID}))

	for _, raw := range []string{"", "null", "{", "{}", "[]", `{"unknown":1}`, `{"createdAt":"bad-time"}`, `{} {}`, `{} false`, `{} trailing`} {
		invalid = append(invalid, base64.RawURLEncoding.EncodeToString([]byte(raw)))
	}
	invalid = append(invalid, "not base64", "e30=", "e31")
	for _, cursor := range invalid {
		_, err := NewProjects(nil).List(context.Background(), principal, model.PageRequest{Limit: 50, Cursor: &cursor})
		requireFault(t, err, "invalid_input")
	}
}
