//go:build stress

package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

// The official TypeScript SDK is deliberately external to the Go and CI dependency
// graphs. Install its pinned version in project scratch and provide that root.
func TestStressMCPTeamItemsTypeScriptSDK(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	sdkRoot := os.Getenv("DAYNIGHT_MCP_TYPESCRIPT_SDK_ROOT")
	if sdkRoot == "" {
		t.Fatal("DAYNIGHT_MCP_TYPESCRIPT_SDK_ROOT must name a local installation of @modelcontextprotocol/sdk@1.32.2")
	}
	sdkRoot, err := filepath.Abs(sdkRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(sdkRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json")); err != nil {
		t.Fatalf("official TypeScript SDK installation: %v", err)
	}
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	production := httptest.NewServer(handler)
	defer production.Close()
	actor := handler.principal
	directory, err := teamservice.NewTeams(db).Create(t.Context(), actor, coreteam.CreateTeam{Name: "TypeScript directory", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]map[string]map[string]*string{"team": {}, "member": {}, "project": {}}
	text := func(value string) *string { return &value }
	large := strings.Repeat("名😀\"\n", 3000)
	var largeMember string
	for i, value := range []string{large, "Following"} {
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
		if i == 0 {
			largeMember = member
		}
		want["member"][member] = map[string]*string{"profile.name": text(value), "profile.email": nil, "profile.avatarUrl": text("")}
		project, err := projectservice.NewProjects(db).Create(t.Context(), actor, coreproject.CreateProject{Name: value, RepoURL: fmt.Sprintf("https://example.com/typescript-team-item-%d", i), TeamID: &directory.ID, ExpectedUserID: actor.UserID})
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
	cmd := exec.CommandContext(t.Context(), "node", "testdata/mcp-team-item-client.mts")
	cmd.Env = append(os.Environ(), "DAYNIGHT_MCP_TYPESCRIPT_SDK_ROOT="+sdkRoot)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	encoder := json.NewEncoder(stdin)
	if err := encoder.Encode(map[string]any{"endpoint": production.URL + "/mcp", "token": handler.token, "team": directory.ID, "member": largeMember, "want": want}); err != nil {
		t.Fatal(err)
	}
	mutated, completed := false, false
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "MCP_TS_MUTATE":
			if mutated {
				t.Fatal("TypeScript client requested duplicate mutation")
			}
			if _, err := db.Pool.Exec(t.Context(), `UPDATE users SET name=name||'changed',updated_at=updated_at WHERE id=$1`, largeMember); err != nil {
				t.Fatal(err)
			}
			mutated = true
			if err := encoder.Encode(map[string]bool{"continue": true}); err != nil {
				t.Fatal(err)
			}
		case strings.HasPrefix(line, "MCP_TS_COMPLETE "):
			completed = true
			t.Log(line)
		default:
			t.Fatalf("unexpected TypeScript client output %q", line)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("TypeScript SDK client: %v", err)
	}
	if !mutated || !completed {
		t.Fatal("TypeScript SDK did not complete enumeration, reconstruction and timestamp conflict")
	}
}
