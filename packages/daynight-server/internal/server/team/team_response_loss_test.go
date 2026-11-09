package team

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestTeamCommittedWritesSurviveLostHTTPResponses(t *testing.T) {
	for _, short := range []bool{false, true} {
		name := "failed"
		if short {
			name = "short"
		}
		t.Run(name, func(t *testing.T) {
			h := authTestHarness(t)
			logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
			mux := http.NewServeMux()
			h.Auth.RegisterRoutes(mux)
			RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
			h.Handler = httpx.RequestLogging(logger, mux)
			admin, member := h.Login(t, "team-loss-admin"), h.Login(t, "team-loss-member")
			adminID := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{admin}, nil, ""), 200).ID
			memberID := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{member}, nil, ""), 200).ID
			team := decodeResponse[api.Team](t, h.Request("POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Before", ExpectedUserID: adminID}), []*http.Cookie{admin}, nil, h.Origin), 201)

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			observer, err := pgx.ConnectConfig(ctx, h.Database.Pool.Config().ConnConfig.Copy())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				closeContext, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer closeCancel()
				if err := observer.Close(closeContext); err != nil {
					t.Error(err)
				}
			})
			projectID := uuid.NewString()
			if _, err := observer.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, memberID); err != nil {
				t.Fatal(err)
			}
			if _, err := observer.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'p','https://example.test/repo')`, projectID); err != nil {
				t.Fatal(err)
			}
			if _, err := observer.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, team.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := observer.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, memberID); err != nil {
				t.Fatal(err)
			}
			var memberVersion int64
			var grantBefore string
			if err := observer.QueryRow(ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, memberID).Scan(&memberVersion); err != nil {
				t.Fatal(err)
			}
			if err := observer.QueryRow(ctx, `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, memberID).Scan(&grantBefore); err != nil {
				t.Fatal(err)
			}
			lost := func(method, path, body, requestID string) {
				t.Helper()
				request := httptest.NewRequest(method, path, strings.NewReader(body))
				request.AddCookie(admin)
				request.Header.Set("Origin", h.Origin)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-Request-ID", requestID)
				writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
				h.Handler.ServeHTTP(writer, request)
				if writer.Code != http.StatusOK || writer.calls != 1 || writer.Body.Len() != 0 {
					t.Fatalf("lost response: status=%d writes=%d bytes=%d", writer.Code, writer.calls, writer.Body.Len())
				}
			}
			lost("PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, api.ChangeTeamRequest{Name: "private-renamed-team", Version: team.Version, ExpectedUserID: adminID}), "rename-loss")
			var gotName string
			var gotVersion int64
			if err := observer.QueryRow(ctx, `SELECT name,version FROM teams WHERE id=$1`, team.ID).Scan(&gotName, &gotVersion); err != nil || gotName != "private-renamed-team" || gotVersion != team.Version+1 {
				t.Fatalf("independent rename observation: name=%q version=%d error=%v", gotName, gotVersion, err)
			}
			lost("DELETE", "/api/v1/teams/"+team.ID+"/members/"+memberID, jsonBody(t, api.RemoveTeamMemberRequest{Version: memberVersion, ExpectedUserID: adminID}), "remove-loss")
			var count int
			var grantAfter string
			if err := observer.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, memberID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("independent removal observation: count=%d error=%v", count, err)
			}
			if err := observer.QueryRow(ctx, `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, memberID).Scan(&grantAfter); err != nil || grantAfter != grantBefore {
				t.Fatalf("independent grant changed after removal: %v", err)
			}
			if strings.Contains(h.Logs.String(), "private-renamed-team") || strings.Contains(h.Logs.String(), "private response failure") {
				t.Fatal("response failure exposed private data in logs")
			}
		})
	}
}
