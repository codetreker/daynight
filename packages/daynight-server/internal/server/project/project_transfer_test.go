package project

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

func TestTransferHTTPContracts(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	target := uuid.NewString()
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO teams(id,name,version) VALUES($1,'Destination private',9007199254740993)`, target); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, target, h.memberID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + h.project.ID
	previewResponse := h.call("POST", path+"/transfer-preview", `{"targetTeamId":"`+target+`"}`, h.admin)
	preview := decodeResponse[api.TransferPreview](t, previewResponse, 200)
	if preview.TargetTeam.ID != target || preview.TargetTeam.Version != 9007199254740993 || preview.SourceTeam.ID != h.project.Ownership.TeamID || preview.Ownership.Version != 1 || preview.ActorRole == nil || *preview.ActorRole != "admin" {
		t.Fatalf("preview: %s", previewResponse.Body)
	}
	if previewResponse.Header().Get("Cache-Control") != "no-store" || previewResponse.Header().Get("Daynight-User-ID") != h.adminID || !strings.Contains(previewResponse.Body.String(), `"version":9007199254740993`) {
		t.Fatal("preview headers or precision", previewResponse.Body, previewResponse.Header())
	}
	input := `{"ownership":{"teamId":"` + preview.Ownership.TeamID + `","version":1},"targetTeam":{"id":"` + target + `","version":9007199254740993},"expectedUserId":"` + h.adminID + `"}`
	wrong := strings.Replace(input, h.adminID, h.memberID, 1)
	assertProjectError(t, h.call("POST", path+"/transfer", wrong, h.admin), 409, "identity_mismatch")
	stale := strings.Replace(input, `"version":9007199254740993`, `"version":1`, 1)
	assertProjectError(t, h.call("POST", path+"/transfer", stale, h.admin), 409, "version_conflict")
	if _, err := h.Database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.adminID); err != nil {
		t.Fatal(err)
	}
	response := h.call("POST", path+"/transfer", input, h.admin)
	receipt := decodeResponse[api.TransferReceipt](t, response, 200)
	if !receipt.Changed || receipt.ProjectID != h.project.ID || receipt.SourceTeam.ID != preview.SourceTeam.ID || receipt.OwnerTeam.ID != target || receipt.Ownership.TeamID != target || receipt.Ownership.Version != 2 || receipt.ActorAccess != nil {
		t.Fatalf("receipt: %s", response.Body)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.adminID || !strings.Contains(response.Body.String(), `"actorAccess":null`) {
		t.Fatal("receipt headers or lost-access result", response.Body, response.Header())
	}
	assertProjectError(t, h.call("GET", path, "", h.admin), 404, "not_found")
	if strings.Contains(h.Logs.String(), "Destination private") || !strings.Contains(h.Logs.String(), `"component":"project_transfer"`) || !strings.Contains(h.Logs.String(), `"outcome":"success"`) {
		t.Fatalf("transfer logs: %s", &h.Logs)
	}
}

func TestTransferHTTPStrictInput(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	path := "/api/v1/projects/" + h.project.ID
	team := h.project.Ownership.TeamID
	valid := `{"ownership":{"teamId":"` + team + `","version":1},"targetTeam":{"id":"` + team + `","version":1},"expectedUserId":"` + h.adminID + `"}`
	for _, body := range []string{
		`{}`, `null`, `{"targetTeamId":null}`, `{"targetTeamId":"` + strings.ToUpper(team) + `"}`, `{"targetTeamId":"https://example.test/teams/` + team + `"}`,
		`{"targetTeamId":"` + team + `","extra":1}`, `{"targetTeamId":"` + team + `","targetTeamId":"` + team + `"}`,
	} {
		assertProjectError(t, h.call("POST", path+"/transfer-preview", body, h.admin), 400, "invalid_input")
	}
	for _, body := range []string{
		`{}`, `{"ownership":null}`, strings.Replace(valid, `"version":1`, `"version":0`, 1),
		strings.Replace(valid, `"version":1`, `"version":1.0`, 1), strings.Replace(valid, `"version":1`, `"version":9223372036854775808`, 1),
		strings.Replace(valid, `"teamId":`, `"teamId":"`+team+`","teamId":`, 1),
		strings.Replace(valid, `"teamId":`, `"extra":true,"teamId":`, 1),
		strings.Replace(valid, `"expectedUserId"`, `"unexpected"`, 1), strings.Replace(valid, team, strings.ToUpper(team), 1),
	} {
		assertProjectError(t, h.call("POST", path+"/transfer", body, h.admin), 400, "invalid_input")
	}
	assertProjectError(t, h.call("POST", path+"/transfer?unexpected=1", valid, h.admin), 400, "invalid_input")
	for _, endpoint := range []string{"/transfer", "/transfer-preview"} {
		response := h.call("GET", path+endpoint, "", h.admin)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != "POST" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(response.Header())
		}
	}
	receipt := decodeResponse[api.TransferReceipt](t, h.call("POST", path+"/transfer", valid, h.admin), 200)
	if receipt.Changed || receipt.Ownership.Version != 1 || receipt.ActorAccess == nil {
		t.Fatalf("verified no-op: %#v", receipt)
	}
}

func TestTransferHTTPLostResponseAndSubsequent404(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	target := uuid.NewString()
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Target')`, target); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, target, h.memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.adminID); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/projects/" + h.project.ID
	body := `{"ownership":{"teamId":"` + h.project.Ownership.TeamID + `","version":1},"targetTeam":{"id":"` + target + `","version":1},"expectedUserId":"` + h.adminID + `"}`
	request := httptest.NewRequest("POST", base+"/transfer", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", h.Origin)
	request.Header.Set("X-Request-ID", "project-test")
	request.AddCookie(h.admin)
	before := h.Logs.Len()
	w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	h.Handler.ServeHTTP(w, request)
	if w.calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("failed response was replayed: %d %q", w.calls, w.Body.String())
	}
	transferLogs := h.Logs.String()[before:]
	if strings.Count(transferLogs, `"component":"project_transfer"`) != 1 || !strings.Contains(transferLogs, `"phase":"response"`) || !strings.Contains(transferLogs, `"outcome":"unknown"`) || !strings.Contains(transferLogs, `"error_code":"write_outcome_unknown"`) {
		t.Fatalf("response loss classification: %s", transferLogs)
	}
	var owner string
	var version int64
	if err := h.Database.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, h.project.ID).Scan(&owner, &version); err != nil || owner != target || version != 2 {
		t.Fatalf("transfer not committed once: %s %d %v", owner, version, err)
	}
	assertProjectError(t, h.call("GET", base, "", h.admin), 404, "not_found")
}
