package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPrivateTransferReadsPolicyAfterAuthorityLock(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			projectID, taskID := uuid.NewString(), uuid.NewString()
			if _, err := db.CreateProject(ctx, projectID, "transfer scope", "https://example.test/repo"); err != nil {
				t.Fatal(err)
			}
			var user string
			if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1`, projectID).Scan(&user); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'test')`, taskID, projectID); err != nil {
				t.Fatal(err)
			}
			authority, credential := uuid.NewString(), uuid.NewString()
			hash := sha256.Sum256([]byte(credential))
			var editSQL string
			if kind == "pat" {
				authority = credential
				_, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'test',now(),ARRAY['attachment:read'],1)`, credential, user, hash[:])
				if err != nil {
					t.Fatal(err)
				}
				editSQL = `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:upload'],scope_version=2 WHERE id=$1`
			} else {
				_, err := db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour',ARRAY['attachment:read'],1)`, authority, user)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '1 hour')`, credential, authority, user, hash[:]); err != nil {
					t.Fatal(err)
				}
				editSQL = `UPDATE oauth_grants SET business_scopes=ARRAY['attachment:upload'],scope_version=2 WHERE id=$1`
			}
			p := model.Principal{Kind: model.CredentialKind(kind), UserID: user, CredentialID: credential}
			completion, err := db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
				_, err := scope.(store.TransferAttachmentCredentialScope).CurrentTransferAttachmentAuthorization(ctx, p, kind, uuid.NewString(), projectID, taskID)
				return err
			})
			if err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("attachment mutation admitted a different authority: %+v %v", completion, err)
			}
			completion, err = db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
				auth, err := scope.(store.TransferAttachmentCredentialScope).CurrentTransferAttachmentAuthorization(ctx, p, kind, authority, projectID, taskID)
				if err != nil {
					return err
				}
				if auth.Principal != p || auth.Policy == nil || auth.Policy.Version() != 1 || auth.Policy.Require("attachment:read") != nil {
					return errors.New("attachment mutation did not return the bound authority")
				}
				return auth.Validate()
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("attachment mutation authority: %+v %v", completion, err)
			}
			editor, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer editor.Rollback(context.Background())
			if _, err := editor.Exec(ctx, editSQL, authority); err != nil {
				t.Fatal(err)
			}
			type result struct {
				auth       model.CredentialAuthorization
				completion store.Completion
				err        error
			}
			pid := make(chan int32, 1)
			done := make(chan result, 1)
			finished := false
			defer func() {
				cancel()
				_ = editor.Rollback(context.Background())
				if !finished {
					<-done
				}
			}()
			go func() {
				var auth model.CredentialAuthorization
				completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
					pid <- int32(d.(*privateTransferDAO).tx.Conn().PgConn().PID())
					if err := d.Authorize(ctx, p, kind, authority, projectID, taskID); err != nil {
						return err
					}
					var err error
					auth, err = d.(store.PrivateTransferCredentialScope).CurrentTransferAuthorization(ctx, p)
					return err
				})
				done <- result{auth, completion, err}
			}()
			var readerPID int32
			select {
			case readerPID = <-pid:
			case got := <-done:
				finished = true
				t.Fatalf("transfer transaction did not start: %+v", got)
			case <-ctx.Done():
				t.Fatal("transfer transaction did not start before deadline")
			}
			for {
				var blocked bool
				if err := db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(editor.Conn().PgConn().PID()), readerPID).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case got := <-done:
					finished = true
					t.Fatalf("authorization did not wait for policy edit: %+v", got)
				case <-ctx.Done():
					t.Fatal("authorization did not reach credential lock")
				case <-time.After(5 * time.Millisecond):
				}
			}
			if kind == "oauth" {
				probe, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				_, err = probe.Exec(ctx, `SELECT id FROM oauth_access_tokens WHERE id=$1 FOR UPDATE NOWAIT`, credential)
				_ = probe.Rollback(context.Background())
				if err != nil {
					t.Fatalf("access locked before grant: %v", err)
				}
			}
			if err := editor.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			got := <-done
			finished = true
			if got.err != nil || got.completion.Outcome != store.TransactionCommitted || got.auth.Policy == nil || got.auth.Policy.Version() != 2 || got.auth.Policy.Require("attachment:upload") != nil || !errors.Is(got.auth.Policy.Require("attachment:read"), scopepolicy.ErrInsufficientScope) {
				t.Fatalf("policy after edit: %+v, %+v, %v", got.auth, got.completion, got.err)
			}
			if err := got.auth.Validate(); err != nil {
				t.Fatal(err)
			}
			if kind == "oauth" {
				// A new access token for the same grant inherits its current policy.
				replacement := uuid.NewString()
				replacementHash := sha256.Sum256([]byte(replacement))
				if _, err := db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '1 hour')`, replacement, authority, user, replacementHash[:]); err != nil {
					t.Fatal(err)
				}
				p.CredentialID = replacement
			}
			completion, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
				capability := d.(store.PrivateTransferCredentialScope)
				if _, err := capability.CurrentTransferAuthorization(ctx, p); err == nil {
					return errors.New("policy read before admission succeeded")
				}
				if err := d.Authorize(ctx, p, kind, authority, projectID, taskID); err != nil {
					return err
				}
				other := p
				other.CredentialID = uuid.NewString()
				if _, err := capability.CurrentTransferAuthorization(ctx, other); err == nil {
					return errors.New("policy read with mismatched principal succeeded")
				}
				auth, err := capability.CurrentTransferAuthorization(ctx, p)
				if err != nil {
					return err
				}
				if auth.Policy.Version() != 2 || auth.Policy.Require("attachment:upload") != nil {
					return errors.New("replacement policy did not match grant")
				}
				return nil
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("policy binding: %+v %v", completion, err)
			}
			// The same authority lock protects the admitted transaction until commit.
			editor2, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer editor2.Rollback(context.Background())
			editDone := make(chan error, 1)
			editStarted := false
			defer func() {
				if editStarted {
					cancel()
					<-editDone
				}
			}()
			completion, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
				if err := d.Authorize(ctx, p, kind, authority, projectID, taskID); err != nil {
					return err
				}
				if _, err := d.(store.PrivateTransferCredentialScope).CurrentTransferAuthorization(ctx, p); err != nil {
					return err
				}
				go func() {
					_, e := editor2.Exec(ctx, editSQL, authority)
					if e == nil {
						e = editor2.Commit(ctx)
					}
					editDone <- e
				}()
				editStarted = true
				readerPID := int32(d.(*privateTransferDAO).tx.Conn().PgConn().PID())
				for {
					var blocked bool
					if err := db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, readerPID, int32(editor2.Conn().PgConn().PID())).Scan(&blocked); err != nil {
						return err
					}
					if blocked {
						return nil
					}
					select {
					case e := <-editDone:
						editStarted = false
						return errors.Join(errors.New("scope edit did not wait for transfer transaction"), e)
					case <-ctx.Done():
						return ctx.Err()
					case <-time.After(5 * time.Millisecond):
					}
				}
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("admitted transfer: %+v %v", completion, err)
			}
			if err := <-editDone; err != nil {
				t.Fatalf("edit after transfer: %v", err)
			}
			editStarted = false
			var corruptSQL string
			if kind == "pat" {
				corruptSQL = `UPDATE personal_access_tokens SET business_scopes=ARRAY['unknown'] WHERE id=$1`
			} else {
				corruptSQL = `UPDATE oauth_grants SET business_scopes=ARRAY['unknown'] WHERE id=$1`
			}
			if _, err := db.Pool.Exec(ctx, corruptSQL, authority); err != nil {
				t.Fatal(err)
			}
			completion, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
				if err := d.Authorize(ctx, p, kind, authority, projectID, taskID); err != nil {
					return err
				}
				_, err := d.(store.PrivateTransferCredentialScope).CurrentTransferAuthorization(ctx, p)
				return err
			})
			if err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("corrupt policy admitted: %+v %v", completion, err)
			}
		})
	}
}

func TestPrivateTransferDueReportsCancellationAndScanFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := transferRecord(uuid.NewString(), now.Add(-2*time.Hour))
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, _, err = transfer.Create(ctx, d, record)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Due(canceled, now, 10)
		return err
	})
	if !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("canceled due query: completion=%+v error=%v", completion, err)
	}
	// An incompatible row simulates a database/schema problem after a query has
	// started returning data. The selection update must roll back on scan failure.
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE private_transfers ALTER COLUMN path DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE private_transfers SET path=NULL WHERE id=$1`, record.ID); err != nil {
		t.Fatal(err)
	}
	completion, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Due(ctx, now, 10)
		return err
	})
	var databaseErr *store.Error
	if err == nil || !errors.As(err, &databaseErr) || databaseErr.Phase != "read private transfer" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("invalid due row: completion=%+v error=%v", completion, err)
	}
	var version int64
	var attempted *time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT version,last_cleanup_attempt FROM private_transfers WHERE id=$1`, record.ID).Scan(&version, &attempted); err != nil || version != record.Version || attempted != nil {
		t.Fatalf("failed scan changed selection: version=%d attempted=%v error=%v", version, attempted, err)
	}
}

func TestPrivateTransferPrunePropagatesDeleteFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := transferRecord(uuid.NewString(), now.Add(-2*time.Hour))
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, _, err = transfer.Create(ctx, d, record)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		record.State = "cleanup_pending"
		var err error
		record, err = transfer.Update(ctx, d, record, record.Version)
		if err != nil {
			return err
		}
		record, err = transfer.Close(ctx, d, record.ID, record.Version, now.Add(-time.Minute))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_transfer_prune() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='prune rejected'; END $$;
		CREATE TRIGGER reject_transfer_prune BEFORE DELETE ON private_transfers FOR EACH ROW EXECUTE FUNCTION reject_transfer_prune()`); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Prune(ctx, now, 10)
		return err
	})
	var databaseErr *store.Error
	var postgresErr *pgconn.PgError
	if err == nil || !errors.As(err, &databaseErr) || databaseErr.Phase != "prune private transfers" || !errors.As(err, &postgresErr) || postgresErr.Code != "P1001" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("prune failure: completion=%+v error=%v", completion, err)
	}
	var state string
	if err := db.Pool.QueryRow(ctx, `SELECT state FROM private_transfers WHERE id=$1`, record.ID).Scan(&state); err != nil || state != "closed" {
		t.Fatalf("failed prune changed record: state=%q error=%v", state, err)
	}
}
