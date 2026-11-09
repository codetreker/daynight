package project_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coreattachment "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/google/uuid"
)

func TestProjectDeletionHTTPDurableResources(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	admin := h.Login(t, "acceptance-admin")
	principal, err := h.Identity.Authenticate(context.Background(), model.SessionCredential, admin.Value)
	if err != nil {
		t.Fatal(err)
	}
	adminID := principal.UserID
	call := func(method, path, body string) *httptest.ResponseRecorder {
		return h.Request(method, path, body, []*http.Cookie{admin}, nil, h.Origin)
	}
	ctx := context.Background()
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	start := func() {
		app := application.New(h.Database, files, nil, "", 0)
		mux := http.NewServeMux()
		h.Auth.RegisterRoutes(mux)
		projecthttp.RegisterRoutes(mux, app.Projects, h.Auth, logger)
		attachmenthttp.RegisterRoutes(mux, app.Attachments, h.Auth, logger)
		taskhttp.TaskRoutes(mux, app.Tasks, app.TaskObservations, h.Auth, logger)
		taskhttp.TaskStepsRoutes(mux, app.TaskSteps, h.Auth, logger)
		taskhttp.TaskThreadRoutes(mux, app.TaskThreads, h.Auth, logger)
		sessionhttp.NewRoutes(app.Sessions, h.Auth, logger).RegisterRoutes(mux)
		h.Handler = httpx.RequestLogging(logger, mux)
	}
	start()
	appForCreate := application.New(h.Database, files, nil, "", 0)
	project, err := appForCreate.Projects.Create(ctx, principal, coreproject.CreateProject{Name: "Delete me", RepoURL: "https://example.com/delete.git", ExpectedUserID: adminID})
	if err != nil {
		t.Fatal(err)
	}
	other, err := appForCreate.Projects.Create(ctx, principal, coreproject.CreateProject{Name: "Other", RepoURL: "https://example.com/other.git", ExpectedUserID: adminID})
	if err != nil {
		t.Fatal(err)
	}
	task, dependency, sid := uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.Database.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO tasks(id,project_id,title,status,version,started_at) VALUES($1,$3,'main','in_progress',7,now()),($2,$3,'dependency','done',3,now())`, task, dependency, project.ID)
	exec(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, task, dependency)
	exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','false')`, task)
	exec(`INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'abcd1234',0,'step','details','done',now(),now())`, task)
	exec(`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES($1,now(),$2,false,'thread history')`, task, adminID)
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,connection_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{"name":"history"}','{"lifecycle":"active","controls":{"x":1}}','abc',now()+interval '1 hour',now()+interval '1 hour')`, sid, project.ID, task, uuid.NewString(), adminID, uuid.NewString())
	exec(`INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{"kind":"history"}')`, sid)
	exec(`INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,1,1,'{"text":"history"}')`, sid, uuid.NewString())
	exec(`INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,'{"name":"resource"}','history')`, sid, uuid.NewString())
	exec(`INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, sid)
	exec(`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'abc','{"op":"history"}',$3,$4,'session','{"state":"accepted"}')`, sid, uuid.NewString(), adminID, uuid.NewString())
	base := "/api/v1/projects/" + project.ID
	taskBase := base + "/tasks/" + task
	content := "retained file bytes\n"
	req := httptest.NewRequest("PUT", taskBase+"/attachments/files/history.txt", strings.NewReader(content))
	req.Header.Set("Origin", h.Origin)
	req.Header.Set("Content-Type", "text/plain")
	req.AddCookie(admin)
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, req)
	if response.Code != 201 {
		t.Fatalf("attachment PUT: %d %s", response.Code, response.Body)
	}
	address, err := coreattachment.NewAddress(project.ID, task, "history.txt")
	if err != nil {
		t.Fatal(err)
	}
	hash := func() [32]byte {
		t.Helper()
		object, err := files.Open(ctx, coreattachment.Bucket, address.StoragePath)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("read file: %v %v", err, closeErr)
		}
		return sha256.Sum256(body)
	}
	expectedHash := hash()
	if expectedHash != sha256.Sum256([]byte(content)) {
		t.Fatal("wrong stored content")
	}
	preserved := func() string {
		t.Helper()
		var result string
		err := h.Database.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
        'project',(SELECT to_jsonb(p)-'deleted_at'-'updated_at'-'task_cache_epoch' FROM projects p WHERE p.id=$1),
        'ownership',(SELECT to_jsonb(o) FROM project_ownership o WHERE o.project_id=$1),
        'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id) FROM project_grants g WHERE g.project_id=$1),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tasks t WHERE t.project_id=$1),
        'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.task_id,p.name) FROM task_properties p JOIN tasks t ON t.id=p.task_id WHERE t.project_id=$1),
        'deps',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.task_id,d.depends_on_task_id) FROM task_dependencies d WHERE d.project_id=$1),
        'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.task_id,a.path) FROM task_attachments a WHERE a.project_id=$1),
        'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.task_id,s.id) FROM task_steps s JOIN tasks t ON t.id=s.task_id WHERE t.project_id=$1),
        'thread',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.task_id,m.message_id) FROM task_thread_messages m JOIN tasks t ON t.id=m.task_id WHERE t.project_id=$1),
        'session',(SELECT to_jsonb(s)-'snapshot'-'grant_hash'-'grant_expires_at'-'connection_expires_at'-'draining_until' FROM task_sessions s WHERE s.id=$2),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_seq) FROM session_events e WHERE e.session_id=$2),
        'timeline',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_seq) FROM session_timeline e WHERE e.session_id=$2),
        'resources',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.resource_id) FROM session_resources r WHERE r.session_id=$2),
        'archives',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.session_id) FROM session_archives a WHERE a.session_id=$2),
        'operations',(SELECT jsonb_agg(to_jsonb(o)-'receipt' ORDER BY o.operation_seq) FROM session_operations o WHERE o.session_id=$2))::text`, project.ID, sid).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := preserved()
	var epoch string
	if err = h.Database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	receipt := testsupport.DecodeResponse[api.ProjectDeletionReceipt](t, call("DELETE", base, ""), 200)
	if receipt.ProjectID != project.ID || !receipt.Deleted {
		t.Fatalf("receipt %+v", receipt)
	}
	if after := preserved(); after != before {
		t.Fatalf("preserved data changed: before=%s after=%s", before, after)
	}
	if got := hash(); got != expectedHash {
		t.Fatalf("file hash changed: %x", got)
	}
	var marked bool
	if err = h.Database.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND task_cache_epoch::text<>$2 FROM projects WHERE id=$1`, project.ID, epoch).Scan(&marked); err != nil || !marked {
		t.Fatalf("Project lifecycle: %t %v", marked, err)
	}
	var retired bool
	err = h.Database.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle'='draining' AND snapshot->'controls' IS NULL AND grant_hash IS NULL AND connection_expires_at IS NULL AND (SELECT receipt->>'state'='rejected' FROM session_operations WHERE session_id=$1) FROM task_sessions WHERE id=$1`, sid).Scan(&retired)
	if err != nil || !retired {
		t.Fatalf("Session controls not retired: %v %v", retired, err)
	}
	if err = files.Close(); err != nil {
		t.Fatal(err)
	}
	files, err = local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	start()
	for _, path := range []string{base, base + "/deletion-preview", taskBase, taskBase + "/steps", taskBase + "/thread", taskBase + "/attachments", taskBase + "/attachments/files/history.txt", taskBase + "/preview/history.txt", taskBase + "/sessions/" + sid + "/timeline"} {
		got := call("GET", path, "")
		if got.Code != 404 {
			t.Errorf("after restart %s: %d %s", path, got.Code, got.Body)
		}
	}
	if got := call("GET", "/api/v1/projects/"+other.ID, ""); got.Code != 200 {
		t.Fatal(fmt.Sprintf("other project: %d %s", got.Code, got.Body))
	}
	if got := hash(); got != expectedHash {
		t.Fatal("file changed after restarting application")
	}
}
