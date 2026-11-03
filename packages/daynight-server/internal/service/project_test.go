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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireFault(t *testing.T, err error, code string) *Fault {
	t.Helper()
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

func TestCreateAndGetProject(t *testing.T) {
	projects, _, _, principal := projectService(t)
	ctx := context.Background()
	input := CreateProject{Name: "  Application project  ", RepoURL: "ssh://git@Git.Example:2222/Team/Application.git"}
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
	if !errors.Is(fault, core.ErrNotFound) || fault.TaskIDs != nil || fault.Unwrap() == nil {
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
		_, err := projects.Create(context.Background(), principal, CreateProject{Name: name, RepoURL: "https://example.com/repo"})
		requireFault(t, err, "invalid_input")
	}
	_, err := projects.Create(context.Background(), principal, CreateProject{Name: "Project", RepoURL: "https://secret-token@example.com/repo"})
	requireFault(t, err, "invalid_input")
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatal("validation disclosed input credentials")
	}
	sentinel := errors.New("entropy unavailable")
	uuid.SetRand(entropyFailure{sentinel})
	t.Cleanup(func() { uuid.SetRand(rand.Reader) })
	_, err = projects.Create(context.Background(), principal, CreateProject{Name: "Project", RepoURL: "https://example.com/repo"})
	var fault *Fault
	if !errors.Is(err, sentinel) || errors.As(err, &fault) {
		t.Fatalf("entropy failure must retain operational cause: %v", err)
	}
}

func TestProjectStoreFailuresRemainOperational(t *testing.T) {
	projects, database, _, principal := projectService(t)
	database.Close()
	ctx := context.Background()
	_, createErr := projects.Create(ctx, principal, CreateProject{Name: "Project", RepoURL: "https://example.com/repo"})
	_, getErr := projects.Get(ctx, principal, "00000000-0000-0000-0000-000000000001")
	_, listErr := projects.List(ctx, principal, PageRequest{Limit: 50})
	for _, err := range []error{createErr, getErr, listErr} {
		var fault *Fault
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
	_, listErr := projects.List(context.Background(), principal, PageRequest{Limit: 50})
	for _, err := range []error{getErr, listErr} {
		var fault *Fault
		var pgError *pgconn.PgError
		if err == nil || errors.As(err, &fault) || !errors.As(err, &pgError) || pgError.Code != "42P01" {
			t.Fatalf("query error was masked: %#v", err)
		}
	}
}

type cancelAfterProjectQuery struct{ cancel context.CancelFunc }

func (t cancelAfterProjectQuery) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, queryContextKey{}, strings.Contains(data.SQL, "FROM project_members"))
}

type queryContextKey struct{}

func (t cancelAfterProjectQuery) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(queryContextKey{}) == true {
		t.cancel()
	}
}

func TestSnapshotCompletionFailureDominatesMissingProject(t *testing.T) {
	_, _, databaseURL, principal := projectService(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = cancelAfterProjectQuery{cancel: cancel}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = NewProjects(&store.Store{Pool: pool}).Get(ctx, principal, "00000000-0000-0000-0000-000000000001")
	var fault *Fault
	if err == nil || errors.As(err, &fault) || !errors.Is(err, context.Canceled) {
		t.Fatalf("failed snapshot completion must not become not_found: %#v", err)
	}
}

func TestProjectPagination(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	empty, err := projects.List(ctx, principal, PageRequest{Limit: 1})
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
	request := PageRequest{Limit: 2}
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
			position, err := projectListPage(PageRequest{Limit: 2, Cursor: page.NextCursor})
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
	page, err := projects.List(ctx, principal, PageRequest{Limit: 100})
	if err != nil || len(page.Items) != 4 || page.NextCursor != nil {
		t.Fatalf("all projects: %#v, %v", page, err)
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
	_, err := projects.List(context.Background(), principal, PageRequest{Limit: 1})
	var fault *Fault
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
		_, err := NewProjects(nil).List(context.Background(), principal, PageRequest{Limit: limit})
		requireFault(t, err, "invalid_input")
	}
	valid := listCursor{Version: 1, Kind: "projects", CreatedAt: time.Now().UTC(), ID: "f47ac10b-58cc-11cf-a447-001122334455"}
	status, ready := "todo", false
	var invalid []string
	for _, mutate := range []func(*listCursor){
		func(c *listCursor) { c.Version = 2 },
		func(c *listCursor) { c.Kind = "tasks" },
		func(c *listCursor) { c.ProjectID = "00000000-0000-0000-0000-000000000001" },
		func(c *listCursor) { c.Status = &status },
		func(c *listCursor) { c.Ready = &ready },
		func(c *listCursor) { c.CreatedAt = time.Time{} },
		func(c *listCursor) { c.ID = "bad-id" },
		func(c *listCursor) { c.ID = strings.ToUpper(c.ID) },
	} {
		cursor := valid
		mutate(&cursor)
		invalid = append(invalid, cursorJSON(t, cursor))
	}
	for _, raw := range []string{"", "null", "{", "{}", "[]", `{"unknown":1}`, `{"createdAt":"bad-time"}`, `{} {}`, `{} false`, `{} trailing`} {
		invalid = append(invalid, base64.RawURLEncoding.EncodeToString([]byte(raw)))
	}
	invalid = append(invalid, "not base64", "e30=", "e31")
	for _, cursor := range invalid {
		_, err := NewProjects(nil).List(context.Background(), principal, PageRequest{Limit: 50, Cursor: &cursor})
		requireFault(t, err, "invalid_input")
	}
}
