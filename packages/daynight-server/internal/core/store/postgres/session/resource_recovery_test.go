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
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	redisgates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	redisstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/google/uuid"
)

func resourceRecoveryGates(t *testing.T, redisURL string) *redisgates.Gates {
	t.Helper()
	client, err := redisstore.NewClient(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	return redisgates.New(client)
}

func TestMediaLeaseRecoveryRestoresSessionAccountAndDeploymentCapacityAfterCrash(t *testing.T) {
	redisURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("DAYNIGHT_TEST_REDIS_URL is required for Session media lease crash recovery")
	}
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
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMediaLeaseCrashOwnerProcess$")
	child.Env = append(os.Environ(),
		"DAYNIGHT_MEDIA_LEASE_REDIS="+redisURL,
		"DAYNIGHT_MEDIA_LEASE_IDS="+leases[0].ID+","+leases[1].ID,
	)
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
		_ = child.Process.Kill()
		waitErr := child.Wait()
		waited = true
		t.Fatalf("child did not acquire exact gates: output=%q scan=%v exit=%v stderr=%s", scanner.Text(), scanner.Err(), waitErr, stderr.String())
	}
	files, err := local.NewWithGates(t.TempDir(), resourceRecoveryGates(t, redisURL))
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
	requireOriginalOwners := func() {
		t.Helper()
		remaining := list()
		if len(remaining) != 2 {
			t.Fatalf("original owners reaped or orphaned deployment rows retained: %v", remaining)
		}
		for _, r := range remaining {
			if r.ID != leases[0].ID && r.ID != leases[1].ID {
				t.Fatalf("recovery retained an unrelated owner: %v", r)
			}
		}
	}
	if err = engine.RecoverMediaLeases(ctx, list(), release); err != nil {
		t.Fatal(err)
	}
	requireOriginalOwners()
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
	requireOriginalOwners()
	// SIGKILL stops renewal without deleting either key. Wait for Redis to
	// expire both leases before asking recovery to reconcile their capacities.
	for _, r := range leases[:2] {
		permit, err := files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+r.ID)
		if err != nil {
			t.Fatalf("media gate %s did not expire after owner exit: %v", r.ID, err)
		}
		if err := permit.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err = engine.RecoverMediaLeases(ctx, list(), release); err != nil {
		t.Fatal(err)
	}
	if remaining := list(); len(remaining) != 0 {
		t.Fatalf("crash-released owners retained: %v", remaining)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).AcquireSessionResourceLease(ctx, store.SessionResourceLease{Admission: store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}, SessionID: sessions[0], ID: uuid.NewString(), OwnerID: owners[0], Kind: "write"})
	})
}

func TestMediaLeaseCrashOwnerProcess(t *testing.T) {
	redisURL := os.Getenv("DAYNIGHT_MEDIA_LEASE_REDIS")
	if redisURL == "" {
		return
	}
	gates := resourceRecoveryGates(t, redisURL)
	for _, id := range strings.Split(os.Getenv("DAYNIGHT_MEDIA_LEASE_IDS"), ",") {
		gate, e := gates.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+id)
		if e != nil {
			t.Fatal(e)
		}
		defer gate.Close()
	}
	fmt.Println("locked")
	time.Sleep(time.Hour)
}
