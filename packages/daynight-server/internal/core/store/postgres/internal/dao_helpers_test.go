package pg_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func helperTransaction(t *testing.T) pgx.Tx {
	t.Helper()
	database, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	tx, err := database.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := tx.Rollback(context.Background()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(err)
		}
	})
	return tx
}
func helperExec(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func helperTask(t *testing.T, tx pgx.Tx) (string, string) {
	t.Helper()
	project, task := uuid.NewString(), uuid.NewString()
	helperExec(t, tx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','repo')`, project)
	helperExec(t, tx, `INSERT INTO tasks(id,project_id,title,description,status) VALUES($1,$2,'Task','Body','todo')`, task, project)
	return project, task
}
func TestTaskHelpersReadPropertiesStepsPresenceAndDeletion(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	project, task := helperTask(t, tx)
	missing := uuid.NewString()
	properties := model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque","title":"Change"}]`), "paused": json.RawMessage(`true`)}
	if err := pg.WriteTaskProperties(ctx, tx, task, properties); err != nil {
		t.Fatal(err)
	}
	actual, err := pg.ReadTaskWithLock(ctx, tx, project, task, " FOR UPDATE")
	if err != nil || actual.ID != task || actual.ProjectID != project || actual.Title != "Task" || actual.Description != "Body" || actual.Status != model.TaskTodo || !reflect.DeepEqual(actual.Properties, properties) {
		t.Fatalf("task=%#v, err=%v", actual, err)
	}
	loaded, err := pg.LoadTaskProperties(ctx, tx, []string{task, missing})
	if err != nil || !reflect.DeepEqual(loaded[task], properties) || loaded[missing] == nil || len(loaded[missing]) != 0 {
		t.Fatalf("loaded=%#v, err=%v", loaded, err)
	}
	empty, err := pg.LoadTaskProperties(ctx, tx, nil)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty=%#v, err=%v", empty, err)
	}
	tasks := []model.Task{{ID: task}, {ID: missing}}
	if err := pg.AttachTaskProperties(ctx, tx, tasks); err != nil || !reflect.DeepEqual(tasks[0].Properties, properties) || tasks[1].Properties == nil {
		t.Fatalf("attached=%#v, err=%v", tasks, err)
	}
	properties = model.TaskProperties{"paused": json.RawMessage(`false`)}
	if err := pg.WriteTaskProperties(ctx, tx, task, properties); err != nil {
		t.Fatal(err)
	}
	loaded, err = pg.LoadTaskProperties(ctx, tx, []string{task})
	if err != nil || !reflect.DeepEqual(loaded[task], properties) {
		t.Fatalf("replacement=%#v, err=%v", loaded, err)
	}
	header, err := pg.ReadTaskHeader(ctx, tx, project, task, " FOR SHARE")
	if err != nil || header.ID != task || header.ProjectID != project || header.Version != 1 || header.DeletedAt != nil {
		t.Fatalf("header=%#v, err=%v", header, err)
	}
	presence, err := pg.TaskPresence(ctx, tx, project, task, " FOR SHARE")
	if err != nil || !presence.Found || presence.DeletedAt != nil {
		t.Fatalf("presence=%#v, err=%v", presence, err)
	}
	presence, err = pg.TaskPresence(ctx, tx, project, missing, "")
	if err != nil || presence.Found {
		t.Fatalf("missing presence=%#v, err=%v", presence, err)
	}
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("fixture", 7200))
	helperExec(t, tx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00000002',1,'Second','Two','in_progress',$2,$2),($1,'00000001',0,'First','One','todo',$2,$2)`, task, stamp)
	steps, err := pg.ReadTaskSteps(ctx, tx, task)
	if err != nil || len(steps) != 2 || steps[0].ID != "00000001" || steps[1].Title != "Second" || steps[1].Description != "Two" || string(steps[1].Status) != "in_progress" || steps[0].CreatedAt.Location() != time.UTC || !steps[0].CreatedAt.Equal(stamp) {
		t.Fatalf("steps=%#v, err=%v", steps, err)
	}
	steps, err = pg.ReadTaskSteps(ctx, tx, missing)
	if err != nil || steps == nil || len(steps) != 0 {
		t.Fatalf("empty steps=%#v, err=%v", steps, err)
	}
	helperExec(t, tx, `UPDATE tasks SET deleted_at=$2 WHERE id=$1`, task, stamp)
	presence, err = pg.TaskPresence(ctx, tx, project, task, "")
	if err != nil || !presence.Found || presence.DeletedAt == nil || !presence.DeletedAt.Equal(stamp) || presence.DeletedAt.Location() != time.UTC {
		t.Fatalf("deleted presence=%#v, err=%v", presence, err)
	}
	header, err = pg.ReadTaskHeader(ctx, tx, project, task, "")
	if err != nil || header.DeletedAt == nil || !header.DeletedAt.Equal(stamp) {
		t.Fatalf("deleted header=%#v, err=%v", header, err)
	}
	if _, err := pg.ReadTaskWithLock(ctx, tx, project, task, ""); !errors.Is(err, model.ErrTaskDeleted) {
		t.Fatalf("deleted task=%v", err)
	}
	if _, err := pg.ReadTaskHeader(ctx, tx, project, missing, ""); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing header=%v", err)
	}
}
func TestThreadCredentialKindsExpiryAndOwnership(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	user := uuid.NewString()
	future := time.Now().UTC().Add(20 * time.Minute).Truncate(time.Microsecond)
	for _, tc := range []struct {
		kind  model.CredentialKind
		table string
	}{{model.SessionCredential, "sessions"}, {model.PATCredential, "personal_access_tokens"}, {model.OAuthCredential, "oauth_access_tokens"}} {
		t.Run(tc.table, func(t *testing.T) {
			id := uuid.NewString()
			hash := sha256.Sum256([]byte(id))
			columns := "id,user_id,token_hash,created_at,expires_at"
			values := "$1,$2,$3,now(),$4"
			if tc.kind == model.PATCredential {
				columns += ",name"
				values += ",'Token'"
			}
			if tc.kind == model.OAuthCredential {
				columns += ",grant_id"
				values += ",gen_random_uuid()"
			}
			helperExec(t, tx, `INSERT INTO `+tc.table+`(`+columns+`) VALUES(`+values+`)`, id, user, hash[:], future)
			principal := model.Principal{Kind: tc.kind, CredentialID: id, UserID: user}
			credential, err := pg.ThreadCredential(ctx, tx, principal, " FOR SHARE")
			if err != nil || credential.ExpiresAt == nil || !credential.ExpiresAt.Equal(future) || credential.ExpiresAt.Location() != time.UTC {
				t.Fatalf("credential=%#v, err=%v", credential, err)
			}
			principal.UserID = uuid.NewString()
			if _, err := pg.ThreadCredential(ctx, tx, principal, ""); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("foreign credential=%v", err)
			}
			principal.UserID = user
			helperExec(t, tx, `UPDATE `+tc.table+` SET created_at=now()-interval '2 hours',expires_at=now()-interval '90 minutes' WHERE id=$1`, id)
			if _, err := pg.ThreadCredential(ctx, tx, principal, ""); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("expired credential=%v", err)
			}
			if tc.kind == model.PATCredential {
				helperExec(t, tx, `UPDATE personal_access_tokens SET expires_at=NULL WHERE id=$1`, id)
				credential, err := pg.ThreadCredential(ctx, tx, principal, "")
				if err != nil || credential.ExpiresAt != nil {
					t.Fatalf("perpetual PAT=%#v, err=%v", credential, err)
				}
			}
		})
	}
	if _, err := pg.ThreadCredential(ctx, tx, model.Principal{}, ""); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unknown kind=%v", err)
	}
}
func TestReadThreadMessagePreservesAuthorAndReply(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	_, task := helperTask(t, tx)
	id, user, claim, worker, reply := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("fixture", 7200))
	helperExec(t, tx, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_display_name,author_agent,author_claim_id,author_worker_id,author_provider,body,reply_to_message_id) VALUES($1,$2,$3,$4,'Agent',true,$5,$6,'codex','Body',$7)`, task, id, stamp, user, claim, worker, reply)
	actual, err := pg.ReadThreadMessage(ctx, tx, task, id)
	if err != nil || actual.TaskID != task || actual.ID != id || actual.Author.UserID != user || actual.Author.DisplayName == nil || *actual.Author.DisplayName != "Agent" || !actual.Author.Agent || actual.Author.Execution == nil || actual.Author.Execution.ClaimID != claim || actual.Author.Execution.WorkerID != worker || actual.Author.Execution.Provider != "codex" || actual.Body != "Body" || actual.ReplyTo == nil || *actual.ReplyTo != reply || !actual.CreatedAt.Equal(stamp) || actual.CreatedAt.Location() != time.UTC {
		t.Fatalf("message=%#v, err=%v", actual, err)
	}
	if _, err := pg.ReadThreadMessage(ctx, tx, uuid.NewString(), id); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("cross-task message=%v", err)
	}
}
func TestProjectAuthorizationCombinesDirectAndTeamRoles(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	project, _ := helperTask(t, tx)
	user, team := uuid.NewString(), uuid.NewString()
	helperExec(t, tx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, user, "fixture:"+user)
	helperExec(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	helperExec(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	for _, read := range []struct {
		name string
		fn   func(context.Context, pgx.Tx, string, string) (model.ProjectAccess, error)
	}{{"read", pg.ReadProjectAccess}, {"lock", pg.LockProjectAuthorization}} {
		t.Run(read.name, func(t *testing.T) {
			if _, err := read.fn(ctx, tx, user, project); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("unauthorized=%v", err)
			}
			helperExec(t, tx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, user)
			access, err := read.fn(ctx, tx, user, project)
			if err != nil || access.Role != model.ProjectMemberRole || access.TeamRole == nil || *access.TeamRole != model.ProjectMemberRole || access.DirectGrant != nil || access.CanTransfer || access.OwnerTeam.Kind != "ordinary" || access.OwnerTeam.ID != team || access.Ownership.TeamID != team || access.Ownership.Version != 1 || access.Ownership.UpdatedAt.Location() != time.UTC {
				t.Fatalf("team member=%#v, err=%v", access, err)
			}
			helperExec(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project, user)
			access, err = read.fn(ctx, tx, user, project)
			if err != nil || access.Role != model.ProjectAdmin || access.DirectGrant == nil || access.DirectGrant.Role != model.ProjectAdmin || access.CanTransfer {
				t.Fatalf("direct admin=%#v, err=%v", access, err)
			}
			helperExec(t, tx, `UPDATE team_members SET role='admin' WHERE team_id=$1 AND user_id=$2`, team, user)
			helperExec(t, tx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, project, user)
			helperExec(t, tx, `UPDATE teams SET name=NULL,personal_user_id=$2 WHERE id=$1`, team, user)
			access, err = read.fn(ctx, tx, user, project)
			if err != nil || access.Role != model.ProjectAdmin || !access.CanTransfer || access.OwnerTeam.Kind != "personal" || access.OwnerTeam.Name != nil {
				t.Fatalf("personal owner=%#v, err=%v", access, err)
			}
			helperExec(t, tx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, user)
			access, err = read.fn(ctx, tx, user, project)
			if err != nil || access.Role != model.ProjectMemberRole || access.TeamRole != nil || access.CanTransfer || access.DirectGrant == nil {
				t.Fatalf("direct member=%#v, err=%v", access, err)
			}
			helperExec(t, tx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, user)
			helperExec(t, tx, `UPDATE teams SET name='Team',personal_user_id=NULL WHERE id=$1`, team)
			if _, err := read.fn(ctx, tx, user, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("absent project=%v", err)
			}
		})
	}
	helperExec(t, tx, `DELETE FROM project_ownership WHERE project_id=$1`, project)
	for _, read := range []func(context.Context, pgx.Tx, string, string) (model.ProjectAccess, error){pg.ReadProjectAccess, pg.LockProjectAuthorization} {
		if _, err := read(ctx, tx, user, project); err == nil || !helperCauseContains(err, "ownership") {
			t.Fatalf("orphan ownership=%v", err)
		}
	}
}

type failedHelperTx struct {
	pgx.Tx
	cause error
}

func (tx failedHelperTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return helperErrorRow{tx.cause}
}
func (tx failedHelperTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.cause
}
func (tx failedHelperTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, tx.cause
}

type helperErrorRow struct{ cause error }

func (row helperErrorRow) Scan(...any) error { return row.cause }
func TestHelperQueriesRetainDriverFailures(t *testing.T) {
	cause := &pgconn.PgError{Code: "08006", Message: "connection lost"}
	tx := failedHelperTx{cause: cause}
	ctx := t.Context()
	for _, tc := range []struct {
		name string
		call func() error
	}{
		{"properties read", func() error { _, err := pg.LoadTaskProperties(ctx, tx, []string{uuid.NewString()}); return err }},
		{"properties attach", func() error { return pg.AttachTaskProperties(ctx, tx, []model.Task{{ID: uuid.NewString()}}) }},
		{"properties write", func() error { return pg.WriteTaskProperties(ctx, tx, uuid.NewString(), nil) }},
		{"task", func() error { _, err := pg.ReadTaskWithLock(ctx, tx, "project", "task", ""); return err }},
		{"header", func() error { _, err := pg.ReadTaskHeader(ctx, tx, "project", "task", ""); return err }},
		{"steps", func() error { _, err := pg.ReadTaskSteps(ctx, tx, "task"); return err }},
		{"presence", func() error { _, err := pg.TaskPresence(ctx, tx, "project", "task", ""); return err }},
		{"thread", func() error { _, err := pg.ReadThreadMessage(ctx, tx, "task", "message"); return err }},
		{"credential", func() error {
			_, err := pg.ThreadCredential(ctx, tx, model.Principal{Kind: model.SessionCredential}, "")
			return err
		}},
		{"authorization read", func() error { _, err := pg.ReadProjectAccess(ctx, tx, "user", "project"); return err }},
		{"authorization lock", func() error { _, err := pg.LockProjectAuthorization(ctx, tx, "user", "project"); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.Is(err, cause) || !failed || state != "08006" {
				t.Fatalf("error=%v, facts=%v,%s", err, failed, state)
			}
		})
	}
}

type interceptedHelperTx struct {
	pgx.Tx
	match string
	cause error
}

func (tx interceptedHelperTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, tx.match) {
		return helperErrorRow{tx.cause}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func TestProjectAuthorizationRetainsFailuresFromEachSource(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	project, _ := helperTask(t, tx)
	user, team := uuid.NewString(), uuid.NewString()
	helperExec(t, tx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, user, "fixture:"+user)
	helperExec(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	helperExec(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	cause := &pgconn.PgError{Code: "08006", Message: "source read failed"}
	for _, match := range []string{"SELECT name,personal_user_id", "SELECT role FROM team_members", "SELECT project_id::text,user_id::text,role,version"} {
		t.Run(match, func(t *testing.T) {
			_, err := pg.LockProjectAuthorization(ctx, interceptedHelperTx{Tx: tx, match: match, cause: cause}, user, project)
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.Is(err, cause) || !failed || state != "08006" {
				t.Fatalf("error=%v, facts=%v,%s", err, failed, state)
			}
		})
	}
	helperExec(t, tx, `DELETE FROM teams WHERE id=$1`, team)
	if _, err := pg.LockProjectAuthorization(ctx, tx, user, project); err == nil || !helperCauseContains(err, "owner Team is missing") {
		t.Fatalf("missing Team=%v", err)
	}
	if _, err := pg.ReadProjectAccess(ctx, tx, user, project); err == nil || !helperCauseContains(err, "ownership or owner Team is missing") {
		t.Fatalf("missing Team access=%v", err)
	}
	helperExec(t, tx, `DELETE FROM project_ownership WHERE project_id=$1`, project)
	_, err := pg.LockProjectAuthorization(ctx, interceptedHelperTx{Tx: tx, match: "SELECT EXISTS", cause: cause}, user, project)
	if !errors.Is(err, cause) {
		t.Fatalf("presence query cause=%v", err)
	}
}

func TestProjectAccessRejectsMissingSourceProfile(t *testing.T) {
	tx := helperTransaction(t)
	project, _ := helperTask(t, tx)
	user, team := uuid.NewString(), uuid.NewString()
	helperExec(t, tx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	helperExec(t, tx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	helperExec(t, tx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, user)
	if _, err := pg.ReadProjectAccess(t.Context(), tx, user, project); err == nil || !helperCauseContains(err, "profile is missing or inconsistent") {
		t.Fatalf("orphan grant profile=%v", err)
	}
}

func TestTaskHelpersRejectInvalidStoredProperties(t *testing.T) {
	tx := helperTransaction(t)
	ctx := t.Context()
	project, task := helperTask(t, tx)
	helperExec(t, tx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','null')`, task)
	if _, err := pg.LoadTaskProperties(ctx, tx, []string{task}); err == nil || !helperPhase(err, "decode task property") {
		t.Fatalf("invalid property=%v", err)
	}
	if _, err := pg.ReadTaskWithLock(ctx, tx, project, task, ""); err == nil || !helperPhase(err, "decode task property") {
		t.Fatalf("invalid task property=%v", err)
	}
}

func helperCauseContains(err error, text string) bool {
	var failure *store.Error
	return errors.As(err, &failure) && strings.Contains(failure.Cause.Error(), text)
}

func helperPhase(err error, phase string) bool {
	var failure *store.Error
	return errors.As(err, &failure) && failure.Phase == phase
}
