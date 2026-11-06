package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPTeamItemsReadAndContinueFromTextOnlyResults(t *testing.T) {
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	production := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded := httptest.NewRecorder()
		handler.ServeHTTP(recorded, r)
		var response struct {
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(recorded.Body.Bytes(), &response) == nil {
			var result struct {
				Content json.RawMessage `json:"content"`
			}
			if json.Unmarshal(response.Result, &result) == nil && result.Content != nil && len(response.Result) > 16<<10 {
				t.Errorf("actual SDK CallToolResult exceeds 16 KiB: %d bytes", len(response.Result))
			}
		}
		for key, values := range recorded.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(recorded.Code)
		_, _ = w.Write(recorded.Body.Bytes())
	}))
	defer production.Close()
	client := mcpPATClient(t, production.URL, handler.token)
	actor := handler.principal
	directory, err := teamservice.NewTeams(db).Create(t.Context(), actor, coreteam.CreateTeam{Name: "Directory", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	values := []string{"ordinary", strings.Repeat("名😀", 3000), strings.Repeat("<", 1500), "following", strings.Repeat("終", 7000)}
	want := map[string]map[string]map[string]*string{"team": {}, "member": {}, "project": {}}
	text := func(value string) *string { return &value }
	for i, value := range values {
		created := time.Date(2030, 1, 1, 0, 0, i, 0, time.UTC)
		id := uuid.NewString()
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO teams(id,name,created_at,updated_at) VALUES($1,$2,$3,$3)`, id, value, created); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, id, actor.UserID); err != nil {
			t.Fatal(err)
		}
		member := assignmentHTTPUser(t, db)
		if _, err := db.Pool.Exec(t.Context(), `UPDATE users SET name=$2,email=NULL,avatar_url='' WHERE id=$1`, member, value); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO team_members(team_id,user_id,role,created_at,updated_at) VALUES($1,$2,'member',$3,$3)`, directory.ID, member, created); err != nil {
			t.Fatal(err)
		}
		want["member"][member] = map[string]*string{"profile.name": text(value), "profile.email": nil, "profile.avatarUrl": text("")}
		project, err := projectservice.NewProjects(db).Create(t.Context(), actor, coreproject.CreateProject{Name: value, RepoURL: fmt.Sprintf("https://example.com/team-item-%d", i), TeamID: &directory.ID, ExpectedUserID: actor.UserID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(t.Context(), `UPDATE projects SET created_at=$2 WHERE id=$1`, project.ID, created); err != nil {
			t.Fatal(err)
		}
		want["project"][project.ID] = map[string]*string{"name": text(project.Name), "repoUrl": text(project.RepoURL)}
	}
	rows, err := db.Pool.Query(t.Context(), `SELECT t.id::text,t.name FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1`, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var name *string
		if err := rows.Scan(&id, &name); err != nil {
			t.Fatal(err)
		}
		want["team"][id] = map[string]*string{"name": name}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	var name, email, avatar *string
	if err := db.Pool.QueryRow(t.Context(), `SELECT name,email,avatar_url FROM users WHERE id=$1`, actor.UserID).Scan(&name, &email, &avatar); err != nil {
		t.Fatal(err)
	}
	want["member"][actor.UserID] = map[string]*string{"profile.name": name, "profile.email": email, "profile.avatarUrl": avatar}
	call := func(tool string, arguments map[string]any) map[string]any {
		t.Helper()
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: tool, Arguments: arguments})
		if err != nil || len(result.Content) != 1 {
			t.Fatalf("%s: %+v %v", tool, result, err)
		}
		content, ok := result.Content[0].(*sdk.TextContent)
		if !ok {
			t.Fatalf("%s did not provide text", tool)
		}
		var envelope map[string]any
		if err := json.Unmarshal([]byte(content.Text), &envelope); err != nil {
			t.Fatal(err)
		}
		if (envelope["error"] != nil) != result.IsError {
			t.Fatalf("error marker disagrees: %#v", envelope)
		}
		return envelope
	}
	for _, list := range []struct{ kind, tool string }{{"team", "team_list"}, {"member", "team_member_list"}, {"project", "team_projects"}} {
		t.Run(list.kind, func(t *testing.T) {
			seen := map[string]bool{}
			cursor := ""
			boundaries := 0
			for pages := 0; ; pages++ {
				if pages > len(want[list.kind])*2 {
					t.Fatal("directory did not terminate")
				}
				arguments := map[string]any{"limit": 100}
				if list.kind != "team" {
					arguments["team"] = directory.ID
				}
				if cursor != "" {
					arguments["cursor"] = cursor
				}
				envelope := call(list.tool, arguments)
				if failure, ok := envelope["error"].(map[string]any); ok {
					if failure["code"] != "payload_too_large" || failure["writeOutcome"] != nil {
						t.Fatalf("unrecoverable boundary: %#v", failure)
					}
					refs := failure["refs"].(map[string]any)
					read := refs["readArguments"].(map[string]any)
					inspection := call(refs["readTool"].(string), read)
					if inspection["error"] != nil {
						t.Fatalf("inspect: %#v", inspection)
					}
					data := inspection["data"].(map[string]any)
					header := data["header"].(map[string]any)
					id := teamItemIdentity(list.kind, header)
					if seen[id] || want[list.kind][id] == nil {
						t.Fatalf("duplicate or foreign boundary %s", id)
					}
					for _, raw := range data["fields"].([]any) {
						field := raw.(map[string]any)
						key := field["field"].(string)
						expected, exists := want[list.kind][id][key]
						if !exists || field["isNull"] != (expected == nil) {
							t.Fatalf("unexpected nullable field %#v", field)
						}
						if expected == nil {
							continue
						}
						var content strings.Builder
						offset := "0"
						for {
							args := map[string]any{"kind": list.kind, "team": read["team"], "action": "chunk", "revision": data["revision"], "field": key, "offset": offset, "maxBytes": 4096}
							if list.kind == "member" {
								args["userId"] = id
							}
							if list.kind == "project" {
								args["projectId"] = id
							}
							chunkEnvelope := call("team_item_read", args)
							if chunkEnvelope["error"] != nil {
								t.Fatalf("chunk: %#v", chunkEnvelope)
							}
							chunk := chunkEnvelope["data"].(map[string]any)
							content.WriteString(chunk["text"].(string))
							if chunk["offset"] != offset || (chunk["readBytes"] == "0" && chunk["eof"] != true) {
								t.Fatalf("invalid progress: %#v", chunk)
							}
							offset = chunk["nextOffset"].(string)
							if chunk["eof"] == true {
								break
							}
						}
						if content.String() != *expected || field["sizeBytes"] != strconv.Itoa(len(*expected)) || offset != strconv.Itoa(len(*expected)) {
							t.Fatalf("field %s did not reconstruct exactly", key)
						}
					}
					seen[id] = true
					boundaries++
					next := refs["cursorAfterItem"].(string)
					if next == "" || next == cursor {
						t.Fatal("boundary cursor did not advance")
					}
					cursor = next
					continue
				}
				data := envelope["data"].(map[string]any)
				for _, raw := range data["items"].([]any) {
					item := raw.(map[string]any)
					id := teamItemIdentity(list.kind, item)
					if seen[id] || want[list.kind][id] == nil {
						t.Fatalf("duplicate or unknown normal item %s", id)
					}
					for key, value := range want[list.kind][id] {
						actual := item[key]
						if list.kind == "member" {
							actual = item["profile"].(map[string]any)[strings.TrimPrefix(key, "profile.")]
						}
						if (value == nil && actual != nil) || (value != nil && actual != *value) {
							t.Fatalf("incomplete normal item field %s", key)
						}
					}
					seen[id] = true
				}
				if data["nextCursor"] == nil {
					break
				}
				cursor = data["nextCursor"].(string)
			}
			if len(seen) != len(want[list.kind]) || boundaries != 3 {
				t.Fatalf("directory lost entries: seen=%d expected=%d oversized=%d", len(seen), len(want[list.kind]), boundaries)
			}
		})
	}
}

func teamItemIdentity(kind string, item map[string]any) string {
	if kind == "member" {
		return item["userId"].(string)
	}
	return item["id"].(string)
}
