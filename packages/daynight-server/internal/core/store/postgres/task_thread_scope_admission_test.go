package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

type threadAdmissionStore struct {
	*Store
	started  chan uint32
	hold     chan struct{}
	admitted chan struct{}
}

func (s *threadAdmissionStore) WriteThread(ctx context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
	return s.Store.WriteThread(ctx, func(tx store.ThreadScope) error {
		s.started <- tx.(*ThreadTx).tx.Conn().PgConn().PID()
		err := work(tx)
		if err == nil && s.hold != nil {
			close(s.admitted)
			select {
			case <-s.hold:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return err
	})
}

func TestScopedThreadPolicyEditSerializesWithPost(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.MCP, scopepolicy.PAT} {
		t.Run(string(kind), func(t *testing.T) {
			db, owner, _, project := membershipFixture(t)
			target := queryTask(t, db, project.ID, 10, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			credential, grant := uuid.NewString(), uuid.NewString()
			hash := sha256.Sum256([]byte(credential))
			var table, id string
			principal := model.Principal{UserID: owner.UserID, CredentialID: credential}
			profile := model.ScopedPATProfile
			if kind == scopepolicy.PAT {
				principal.Kind, table, id = model.PATCredential, "personal_access_tokens", credential
				mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'Thread',now(),now()+interval '1 day',ARRAY['thread:post'],1)`, credential, owner.UserID, hash[:])
			} else {
				principal.Kind, profile, table, id = model.OAuthCredential, model.ScopedMCPProfile, "oauth_grants", grant
				mustQueryExec(t, db, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 day',ARRAY['thread:post'],1)`, grant, owner.UserID)
				mustQueryExec(t, db, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, credential, grant, owner.UserID, hash[:])
			}
			policy, err := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"thread:post"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := model.CredentialAuthorization{Principal: principal, Profile: profile, Policy: &policy}
			wrapped := &threadAdmissionStore{Store: db, started: make(chan uint32, 1)}
			threads := service.NewScopedTaskThreads(service.NewTaskThreads(wrapped))
			editor, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer editor.Rollback(context.Background())
			if _, err := editor.Exec(ctx, `UPDATE `+table+` SET business_scopes=ARRAY['thread:read'],scope_version=2 WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := threads.Post(ctx, auth, project.ID, target.ID, service.CreateThreadMessage{Body: "must not commit", Receipt: true})
				done <- err
			}()
			waitThreadBackendLock(t, db, <-wrapped.started)
			if err := editor.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
				t.Fatalf("post after edit: %v", err)
			}
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, target.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("denied post persisted %d messages: %v", count, err)
			}
			mustQueryExec(t, db, `UPDATE `+table+` SET business_scopes=ARRAY['thread:post'],scope_version=3 WHERE id=$1`, id)
			wrapped.hold, wrapped.admitted = make(chan struct{}), make(chan struct{})
			go func() {
				_, err := threads.Post(ctx, auth, project.ID, target.ID, service.CreateThreadMessage{Body: "accepted before edit", Receipt: true})
				done <- err
			}()
			<-wrapped.started
			<-wrapped.admitted
			connection, err := db.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Release()
			edited := make(chan error, 1)
			go func() {
				_, err := connection.Exec(ctx, `UPDATE `+table+` SET business_scopes=ARRAY['thread:read'],scope_version=4 WHERE id=$1`, id)
				edited <- err
			}()
			waitThreadBackendLock(t, db, connection.Conn().PgConn().PID())
			close(wrapped.hold)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if err := <-edited; err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1 AND body='accepted before edit'`, target.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("accepted post persisted %d messages: %v", count, err)
			}
		})
	}
}
