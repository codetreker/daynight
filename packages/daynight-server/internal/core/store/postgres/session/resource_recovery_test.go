package session_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"

	"encoding/json"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestUnsettledResourceBarrierPreservesUnknownEffectsWithoutBlockingReadOnlyControls(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	seq := int64(0)
	for _, kind := range []string{"refresh_controls", "update_setting", "send_message", "interaction_response", "execute_command", "cancel"} {
		for _, state := range []string{"accepted", "offered", "dispatching", "unknown"} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				seq++
				op := uuid.NewString()
				sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
					return d.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: op, Seq: seq, Actor: actor, Hash: []byte("original"), Command: sp.Command{Kind: kind, Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{SessionID: id, OperationID: op, State: state}})
				})
				sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
					n, e := d.(store.SessionResourceDAO).UnsettledSessionResourceWrites(t.Context(), id)
					want := 1
					if kind == "refresh_controls" || kind == "update_setting" {
						want = 0
					}
					if e != nil || n != want {
						t.Fatalf("unsettled=%d want=%d: %v", n, want, e)
					}
					saved, e := d.SessionOperation(t.Context(), id, op)
					if e != nil || saved.Receipt.State != state {
						t.Fatalf("barrier changed receipt: %+v %v", saved.Receipt, e)
					}
					return d.SetSessionOperationReceipt(t.Context(), sp.Operation{SessionID: id, OperationID: op, State: "confirmed"})
				})
			})
		}
	}
	resource, op := uuid.NewString(), uuid.NewString()
	seq++
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		r := d.(store.SessionResourceDAO)
		if e := r.InsertSessionResource(t.Context(), store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "pending", Name: "original.png"}}); e != nil {
			return e
		}
		if e := d.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: op, Seq: seq, Actor: actor, Hash: []byte("pinned"), Command: sp.Command{Kind: "refresh_controls", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "unknown"}}); e != nil {
			return e
		}
		return r.AddSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "operation", ReferenceID: op})
	})
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		n, e := d.(store.SessionResourceDAO).UnsettledSessionResourceWrites(t.Context(), id)
		if e == nil && n != 1 {
			t.Fatalf("unknown pinned operation bypassed closure: %d", n)
		}
		return e
	})
}

func TestMediaLeaseRecoveryRestoresSessionAccountAndDeploymentCapacityAfterCrash(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	sessions, owners := make([]string, 33), make([]string, 9)
	for i := range owners {
		owners[i] = uuid.NewString()
	}
	for i := range sessions {
		sessions[i] = uuid.NewString()
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			if e := d.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: sessions[i], ProjectID: project.ID, TaskID: task.ID}, ClaimID: uuid.NewString(), OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}}); e != nil {
				return e
			}
			_, e := d.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), sessions[i])
			return e
		})
	}
	leases := make([]store.SessionResourceLease, 0, 64)
	for i := 0; i < 32; i++ {
		for n := 0; n < 2; n++ {
			r := store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[i], ID: uuid.NewString(), OwnerID: owners[i/4], Kind: "read"}
			leases = append(leases, r)
			sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
				return d.(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), r)
			})
		}
	}
	requireLimited := func(id, owner string) {
		t.Helper()
		_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).AcquireSessionResourceLease(t.Context(), store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: id, ID: uuid.NewString(), OwnerID: owner, Kind: "read"})
		})
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != "rate_limited" {
			t.Fatalf("expected rate limit, got %v", err)
		}
	}
	requireLimited(sessions[0], owners[0])
	requireLimited(sessions[32], owners[0])
	requireLimited(sessions[32], owners[8])
	root := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMediaLeaseCrashOwnerProcess$")
	child.Env = append(os.Environ(), "DAYNIGHT_MEDIA_LEASE_HELPER="+root, "DAYNIGHT_MEDIA_LEASE_IDS="+leases[0].ID+","+leases[1].ID)
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "locked" {
		t.Fatalf("child did not acquire exact gates: %s %v", stderr.String(), scanner.Err())
	}
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	engine := sessioncore.NewEngine(files)
	list := func() []store.SessionResourceLease {
		var out []store.SessionResourceLease
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			var e error
			out, e = d.(store.SessionResourceLeaseRecoveryDAO).ListSessionMediaLeases(t.Context())
			return e
		})
		return out
	}
	release := func(ctx context.Context, id, lease string) error {
		completion, e := db.WriteSession(ctx, func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, id, lease)
		})
		if e == nil && completion.Outcome != store.TransactionCommitted {
			return errors.New("unconfirmed cleanup")
		}
		return e
	}
	if err = engine.RecoverMediaLeases(ctx, list(), release); err != nil {
		t.Fatal(err)
	}
	remaining := list()
	if len(remaining) != 2 {
		t.Fatalf("live physical owners reaped or orphaned deployment rows retained: %d", len(remaining))
	}
	requireLimited(sessions[0], owners[0])
	// The account and deployment no longer inherit unrelated crashed owners.
	for _, owner := range []string{owners[0], owners[8]} {
		r := store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[32], ID: uuid.NewString(), OwnerID: owner, Kind: "read"}
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			return d.(store.SessionResourceDAO).AcquireSessionResourceLease(ctx, r)
		})
		if err = release(ctx, r.SessionID, r.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err = child.Wait(); err == nil {
		t.Fatal("killed owner unexpectedly succeeded")
	}
	waited = true
	if err = engine.RecoverMediaLeases(ctx, list(), release); err != nil {
		t.Fatal(err)
	}
	if remaining = list(); len(remaining) != 0 {
		t.Fatalf("crash-released owners retained: %v", remaining)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).AcquireSessionResourceLease(ctx, store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[0], ID: uuid.NewString(), OwnerID: owners[0], Kind: "write"})
	})
}

func TestMediaLeaseCrashOwnerProcess(t *testing.T) {
	root := os.Getenv("DAYNIGHT_MEDIA_LEASE_HELPER")
	if root == "" {
		return
	}
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	for _, id := range strings.Split(os.Getenv("DAYNIGHT_MEDIA_LEASE_IDS"), ",") {
		gate, e := files.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+id)
		if e != nil {
			t.Fatal(e)
		}
		defer gate.Close()
	}
	fmt.Println("locked")
	time.Sleep(time.Hour)
}
