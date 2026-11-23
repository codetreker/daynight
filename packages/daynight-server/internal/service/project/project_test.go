package project

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

type projectValidationStore struct{}

func (projectValidationStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("Project request validation unexpectedly called ReadSnapshot")
}

func (projectValidationStore) WriteProject(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
	panic("Project request validation unexpectedly called WriteProject")
}

func (projectValidationStore) WriteProjectCreation(context.Context, string, func(store.ProjectCreationDAO) error) (store.Completion, error) {
	panic("Project request validation unexpectedly called WriteProjectCreation")
}

func projectValidationFixture() (*Projects, model.Principal) {
	principal := model.Principal{
		Kind:         model.SessionCredential,
		UserID:       "00000000-0000-4000-8000-000000000001",
		CredentialID: "00000000-0000-4000-8000-000000000002",
	}
	return NewProjects(projectValidationStore{}), principal
}

func TestCanonicalID(t *testing.T) {
	projects, principal := projectValidationFixture()
	for _, value := range []string{"00000000-0000-0000-0000-000000000000", "F47AC10B-58CC-11CF-A447-001122334455", "f47ac10b-58cc-71cf-a447-001122334455"} {
		got, err := model.CanonicalID(value)
		if err != nil || got != strings.ToLower(value) {
			t.Fatalf("canonical %q: %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"", "f47ac10b58cc11cfa447001122334455", "{f47ac10b-58cc-11cf-a447-001122334455}", "urn:uuid:f47ac10b-58cc-11cf-a447-001122334455", "f47ac10b_58cc-11cf-a447-001122334455", "f47ac10b-58cc_11cf-a447-001122334455", "f47ac10b-58cc-11cf_a447-001122334455", "f47ac10b-58cc-11cf-a447_001122334455", "z47ac10b-58cc-11cf-a447-001122334455"} {
		_, err := model.CanonicalID(value)
		requireFault(t, err, "invalid_input")
		_, err = projects.Get(context.Background(), principal, value)
		requireFault(t, err, "invalid_input")
	}
}

type entropyFailure struct{ err error }

func (r entropyFailure) Read([]byte) (int, error) { return 0, r.err }

func TestCreateValidationAndEntropyFailure(t *testing.T) {
	projects, principal := projectValidationFixture()
	for _, name := range []string{"", " \t\n\u2003", "bad\x00name", "bad\xffname"} {
		_, err := projects.Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: name, RepoURL: "https://example.com/repo"})
		requireFault(t, err, "invalid_input")
	}
	_, err := projects.Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Project", RepoURL: "https://secret-token@example.com/repo"})
	requireFault(t, err, "invalid_input")
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatal("validation disclosed input credentials")
	}
	sentinel := errors.New("entropy unavailable")
	uuid.SetRand(entropyFailure{sentinel})
	t.Cleanup(func() { uuid.SetRand(rand.Reader) })
	_, err = projects.Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Project", RepoURL: "https://example.com/repo"})
	var fault *model.Fault
	if !errors.Is(err, sentinel) || errors.As(err, &fault) {
		t.Fatalf("entropy failure must retain operational cause: %v", err)
	}
}

type listCursor struct {
	Version   int       `json:"version"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

type projectCursor struct {
	Version   int                    `json:"version"`
	Kind      string                 `json:"kind"`
	UserID    string                 `json:"userId"`
	Scope     store.ProjectScopeKind `json:"scope"`
	TeamID    string                 `json:"teamId"`
	CreatedAt time.Time              `json:"createdAt"`
	ID        string                 `json:"id"`
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
	projects, principal := projectValidationFixture()
	for _, limit := range []int{-1, 0, 101} {
		_, err := projects.List(context.Background(), principal, model.PageRequest{Limit: limit})
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
	if _, err := query.ProjectListPage(model.PageRequest{Limit: 50, Cursor: &validEncoded}, principal.UserID, scope); err != nil {
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
		_, err := projects.List(context.Background(), principal, model.PageRequest{Limit: 50, Cursor: &cursor})
		requireFault(t, err, "invalid_input")
	}
}
