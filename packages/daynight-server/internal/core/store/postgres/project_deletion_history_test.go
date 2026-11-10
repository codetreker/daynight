package postgres

import (
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestProjectDeletionPreservesHistoricalRowsAndCommitsRetirement(t *testing.T) {
	db, owner, _, project := membershipFixture(t)
	ctx := t.Context()
	otherID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Unrelated','host:other')`, otherID)
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, otherID, project.Ownership.TeamID)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, otherID, owner.UserID)
	var otherBefore string
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, otherID).Scan(&otherBefore); err != nil {
		t.Fatal(err)
	}
	task, dependency, sid := uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(sql string, args ...any) { t.Helper(); mustQueryExec(t, db, sql, args...) }
	exec(`INSERT INTO tasks(id,project_id,title,status,version,started_at) VALUES($1,$3,'main','in_progress',7,now()),($2,$3,'dependency','done',3,now())`, task, dependency, project.ID)
	exec(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, task, dependency)
	exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','false')`, task)
	exec(`INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'abcd1234',0,'step','details','done',now(),now())`, task)
	exec(`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES($1,now(),$2,false,'thread history')`, task, owner.UserID)
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,connection_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{"name":"history"}','{"lifecycle":"active","controls":{"x":1}}','abc',now()+interval '1 hour',now()+interval '1 hour')`, sid, project.ID, task, uuid.NewString(), owner.UserID, uuid.NewString())
	exec(`INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{"kind":"history"}')`, sid)
	exec(`INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,1,1,'{"text":"history"}')`, sid, uuid.NewString())
	exec(`INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,'{"name":"resource"}','history')`, sid, uuid.NewString())
	exec(`INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, sid)
	exec(`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'abc','{"op":"history"}',$3,$4,'session','{"state":"accepted"}')`, sid, uuid.NewString(), owner.UserID, uuid.NewString())

	exec(`INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'history.txt','text/plain',20)`, project.ID, task)
	preserved := func() string {
		t.Helper()
		var result string
		err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
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
	if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !marked {
			return fmt.Errorf("mark Project: %t %w", marked, err)
		}
		facts, err := scope.SessionDAO().LockProjectSessions(ctx, project.ID, "", 128)
		if err != nil {
			return err
		}
		if len(facts) != 1 || facts[0].ID != sid || facts[0].Backend != "web" || facts[0].Lifecycle != "active" {
			t.Fatalf("retirement facts: %+v", facts)
		}
		return scope.SessionDAO().ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{
			ID: sid, Backend: "web", SnapshotPatch: map[string]any{"lifecycle": "draining"}, SnapshotRemove: []string{"controls"},
			Receipts: []store.ProjectSessionReceiptTransition{{Previous: "accepted", Next: "rejected"}},
		}})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion completion: %+v %v", completion, err)
	}
	if after := preserved(); after != before {
		t.Fatalf("historical rows changed: before=%s after=%s", before, after)
	}
	var marked, retired bool
	if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND task_cache_epoch::text<>$2 FROM projects WHERE id=$1`, project.ID, epoch).Scan(&marked); err != nil || !marked {
		t.Fatalf("Project lifecycle: %t %v", marked, err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle'='draining' AND snapshot->'controls' IS NULL AND grant_hash IS NULL AND grant_expires_at IS NULL AND connection_expires_at IS NULL AND draining_until IS NULL AND (SELECT receipt->>'state'='rejected' FROM session_operations WHERE session_id=$1) FROM task_sessions WHERE id=$1`, sid).Scan(&retired); err != nil || !retired {
		t.Fatalf("Session retirement: %t %v", retired, err)
	}
	var otherAfter string
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, otherID).Scan(&otherAfter); err != nil || otherAfter != otherBefore {
		t.Fatalf("unrelated Project changed: before=%s after=%s error=%v", otherBefore, otherAfter, err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		p, err := snapshot.ProjectDAO().Project(ctx, otherID)
		if err != nil || p.ID != otherID {
			return fmt.Errorf("unrelated Project read: %+v %w", p, err)
		}
		_, err = snapshot.ProjectDAO().Project(ctx, project.ID)
		if !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("deleted Project remained readable: %w", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
