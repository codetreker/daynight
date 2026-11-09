package project

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

func TestProjectDeletionHTTP(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	base := "/api/v1/projects/" + h.project.ID
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.Database.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, h.project.ID, h.memberID)
	task, previous := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO tasks(id,project_id,title,status,version) VALUES($1,$3,'running','in_progress',7),($2,$3,'done','done',4)`, task, previous, h.project.ID)
	exec(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, h.project.ID, task, previous)
	exec(`INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'kept.txt','text/plain',5)`, h.project.ID, task)
	exec(`INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'abcd1234',0,'kept','details','done',now(),now())`, task)
	exec(`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES($1,now(),$2,false,'history')`, task, h.adminID)
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: h.adminID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "fixture"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2),($1,'paused','true')`, task, string(raw))
	exec(`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, h.adminID, claim.WorkerID)
	for _, path := range []string{base, base + "/deletion-preview"} {
		assertProjectError(t, h.call("GET", path, "", nil), 401, "unauthenticated")
		assertProjectError(t, h.call("GET", path, "", h.outsider), 404, "not_found")
	}
	assertProjectError(t, h.call("GET", base+"/deletion-preview", "", h.member), 403, "forbidden")
	assertProjectError(t, h.call("DELETE", base, "", h.member), 403, "forbidden")
	previewResponse := h.call("GET", base+"/deletion-preview", "", h.admin)
	preview := decodeResponse[api.ProjectDeletionPreview](t, previewResponse, 200)
	if preview.Project.ID != h.project.ID || preview.Project.OwnerTeam.ID != h.project.Ownership.TeamID || preview.Summary.TaskCount != 2 || preview.Summary.UnfinishedTaskCount != 1 || preview.Summary.AttachmentCount != 1 || len(preview.ActiveClaims) != 1 || preview.ActiveClaims[0].TaskID != task || !preview.ActiveClaims[0].Worker.Paused || preview.ActiveClaims[0].Worker.Connectivity != "online" || preview.NextCursor != nil {
		t.Fatalf("preview: %s", previewResponse.Body)
	}
	if previewResponse.Header().Get("Cache-Control") != "no-store" || previewResponse.Header().Get("Daynight-User-ID") != h.adminID {
		t.Fatal(previewResponse.Header())
	}
	assertProjectError(t, h.call("DELETE", base, "", h.admin), 409, "active_worker_claims")
	assertProjectError(t, h.call("DELETE", base+"?version=1", "", h.admin), 400, "invalid_input")
	assertProjectError(t, h.call("DELETE", base, `{}`, h.admin), 400, "invalid_input")
	assertProjectError(t, h.call("GET", base+"/deletion-preview?limit=0", "", h.admin), 400, "invalid_input")
	claim.State = model.WorkerReleased
	raw, err = taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'`, task, string(raw))
	preserved := func() string {
		t.Helper()
		var result string
		err := h.Database.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t WHERE project_id=$1),
        'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id) FROM task_dependencies d WHERE project_id=$1),
        'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a WHERE project_id=$1),
        'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.task_id,p.name) FROM task_properties p JOIN tasks t ON t.id=p.task_id WHERE t.project_id=$1),
        'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.task_id,s.id) FROM task_steps s JOIN tasks t ON t.id=s.task_id WHERE t.project_id=$1),
        'thread',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.task_id,m.message_id) FROM task_thread_messages m JOIN tasks t ON t.id=m.task_id WHERE t.project_id=$1))::text`, h.project.ID).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := preserved()
	response := h.call("DELETE", base, "", h.admin)
	receipt := decodeResponse[api.ProjectDeletionReceipt](t, response, 200)
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 2 || receipt.ProjectID != h.project.ID || !receipt.Deleted {
		t.Fatalf("receipt: %s %v", response.Body, err)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.adminID {
		t.Fatal(response.Header())
	}
	if after := preserved(); after != before {
		t.Fatalf("data changed after deletion:\nbefore=%s\nafter=%s", before, after)
	}
	for _, path := range []string{base, base + "/deletion-preview"} {
		assertProjectError(t, h.call("GET", path, "", h.admin), 404, "not_found")
	}
	assertProjectError(t, h.call("DELETE", base, "", h.admin), 404, "not_found")
	if strings.Contains(h.Logs.String(), "running") || strings.Contains(h.Logs.String(), "example.com/shared") {
		t.Fatalf("private text in diagnostics: %s", fmt.Sprint(&h.Logs))
	}
}

func TestProjectDeletionHTTPClaimPagesAndPhases(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	base := "/api/v1/projects/" + h.project.ID
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: h.adminID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "offline"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now()-interval '10 minutes',now()-interval '10 minutes','{}','{}')`, h.adminID, claim.WorkerID); err != nil {
		t.Fatal(err)
	}
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"}
	phases := []model.WorkerPhase{model.WorkerPreparing, model.WorkerExecuting, model.WorkerPaused, model.WorkerWaiting}
	for i, id := range ids {
		claim.Phase = phases[i]
		raw, err := taskproperty.EncodeWorker(&claim)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = h.Database.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,deleted_at) VALUES($1,$2,'blocker',CASE WHEN $3 THEN now() END)`, id, h.project.ID, i == 3); err != nil {
			t.Fatal(err)
		}
		if _, err = h.Database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	path := base + "/deletion-preview?limit=1"
	for i, id := range ids {
		response := h.call("GET", path, "", h.admin)
		page := decodeResponse[api.ProjectDeletionPreview](t, response, 200)
		if len(page.ActiveClaims) != 1 || page.ActiveClaims[0].TaskID != id || page.ActiveClaims[0].Worker.Phase != string(phases[i]) || page.ActiveClaims[0].Worker.Connectivity != "offline" || (page.NextCursor != nil) != (i < len(ids)-1) {
			t.Fatalf("page %d: %s", i, response.Body)
		}
		assertProjectError(t, h.call("DELETE", base, "", h.admin), 409, "active_worker_claims")
		if _, err := h.Database.Pool.Exec(ctx, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, id); err != nil {
			t.Fatal(err)
		}
		if page.NextCursor != nil {
			path = base + "/deletion-preview?limit=1&cursor=" + *page.NextCursor
		}
	}
	receipt := decodeResponse[api.ProjectDeletionReceipt](t, h.call("DELETE", base, "", h.admin), 200)
	if receipt.ProjectID != h.project.ID || !receipt.Deleted {
		t.Fatalf("receipt: %+v", receipt)
	}
}

func TestProjectDeletionHTTPPreviewBudget(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	base := "/api/v1/projects/" + h.project.ID
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: h.adminID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "fixture"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), State: model.WorkerActive, Phase: model.WorkerWaiting, ClaimedAt: time.Now().UTC()}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"}
	for _, id := range ids {
		if _, err = h.Database.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,$3)`, id, h.project.ID, strings.Repeat("<", 100000)); err != nil {
			t.Fatal(err)
		}
		if _, err = h.Database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	path := base + "/deletion-preview?limit=100"
	first := h.call("GET", path, "", h.admin)
	p := decodeResponse[api.ProjectDeletionPreview](t, first, 200)
	if len(first.Body.Bytes()) > 1<<20 || len(p.ActiveClaims) != 1 || p.ActiveClaims[0].TaskID != ids[0] || p.NextCursor == nil {
		t.Fatalf("first budgeted page: bytes=%d claims=%d cursor=%v", first.Body.Len(), len(p.ActiveClaims), p.NextCursor)
	}
	second := h.call("GET", path+"&cursor="+*p.NextCursor, "", h.admin)
	p = decodeResponse[api.ProjectDeletionPreview](t, second, 200)
	if len(second.Body.Bytes()) > 1<<20 || len(p.ActiveClaims) != 1 || p.ActiveClaims[0].TaskID != ids[1] || p.NextCursor != nil {
		t.Fatalf("second budgeted page: bytes=%d claims=%d cursor=%v", second.Body.Len(), len(p.ActiveClaims), p.NextCursor)
	}
	if _, err = h.Database.Pool.Exec(ctx, `UPDATE tasks SET title=$2 WHERE id=$1`, ids[0], strings.Repeat("<", 200000)); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Database.Pool.Exec(ctx, `UPDATE tasks SET title=$2 WHERE id=$1`, ids[1], strings.Repeat("<", 200000)); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.call("GET", path, "", h.admin), 413, "payload_too_large")
}
