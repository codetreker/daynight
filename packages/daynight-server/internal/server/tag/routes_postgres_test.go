package tag

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	"github.com/google/uuid"
)

type postgresTagAuthentication struct{ principal model.Principal }

func (a postgresTagAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.principal) }
}

// Real transaction wrapping must preserve the DAO's reliable conflict at the HTTP boundary.
func TestPostgresNameConflictsReturnConflictWithoutChangingCatalog(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	_, principal, _ := testutil.AuthRecords(t, database)
	project, err := testutil.CreatePrivateProject(t.Context(), database, principal, uuid.NewString(), "Tag conflicts", "https://example.com/tag-conflicts")
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	mux := http.NewServeMux()
	tags := service.New(database)
	RegisterRoutes(mux, tags, postgresTagAuthentication{principal}, logger)
	handler := httpx.RequestLogging(logger, mux)
	path := "/api/v1/projects/" + project.ID + "/tags"
	request := func(method, target, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, target, strings.NewReader(body)).WithContext(t.Context())
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := decode[api.Tag](t, request(http.MethodPost, path, `{"name":"Alpha-中文","color":"#123ABC"}`), http.StatusCreated)
	second := decode[api.Tag](t, request(http.MethodPost, path, `{"name":"Beta","color":"#456DEF"}`), http.StatusCreated)
	before := decode[api.TagPage](t, request(http.MethodGet, path, ""), http.StatusOK)
	if len(before.Items) != 2 {
		t.Fatalf("catalog before conflicts: %+v", before)
	}
	for _, tc := range []struct {
		name, method, target, body string
	}{
		{"same name", http.MethodPost, path, `{"name":"Alpha-中文","color":"#FFFFFF"}`},
		{"ASCII case variant", http.MethodPost, path, `{"name":"aLPHA-中文","color":"#FFFFFF"}`},
		{"rename conflict", http.MethodPatch, path + "/" + second.ID, fmt.Sprintf(`{"version":%d,"name":"ALPHA-中文","color":"#FFFFFF"}`, second.Version)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs.Reset()
			response := decode[api.ErrorResponse](t, request(tc.method, tc.target, tc.body), http.StatusConflict)
			if response.Error.Code != "tag_name_conflict" {
				t.Fatalf("conflict response: %+v", response)
			}
			for _, fact := range []string{`"tx_outcome":"not_committed"`, `"cleanup_failed":false`} {
				if !strings.Contains(logs.String(), fact) {
					t.Fatalf("missing %s in conflict log: %s", fact, &logs)
				}
			}
			after := decode[api.TagPage](t, request(http.MethodGet, path, ""), http.StatusOK)
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("conflict changed catalog: before=%+v after=%+v", before, after)
			}
			for _, original := range []api.Tag{first, second} {
				stored := decode[api.Tag](t, request(http.MethodGet, path+"/"+original.ID, ""), http.StatusOK)
				if !reflect.DeepEqual(stored, original) {
					t.Fatalf("conflict changed original: before=%+v after=%+v", original, stored)
				}
			}
			for id, color := range map[string]string{first.ID: "#123ABC", second.ID: "#456DEF"} {
				stored, err := tags.Get(t.Context(), principal, project.ID, id)
				if err != nil || stored.Tag.Color != color {
					t.Fatalf("conflict changed stored color: id=%s item=%+v error=%v", id, stored, err)
				}
			}
		})
	}
	// A corrected retry uses the unchanged version and succeeds after rollback.
	updated := decode[api.Tag](t, request(http.MethodPatch, path+"/"+second.ID, fmt.Sprintf(`{"version":%d,"name":"Gamma","color":"#FFFFFF"}`, second.Version)), http.StatusOK)
	if updated.ID != second.ID || updated.Name != "Gamma" || updated.Version != second.Version+1 {
		t.Fatalf("corrected retry: %+v", updated)
	}
}
