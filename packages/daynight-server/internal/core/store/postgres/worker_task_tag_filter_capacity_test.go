package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

// The historical target stays at the exact encoded configuration budget while
// migration adds the canonical empty member and a legacy PUT omits it.
func TestWorkerTaskTagFilterMigratedCapacityAndLegacyPut(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user, id := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	value := model.WorkerConfiguration{PlatformTaskMode: model.PlatformTaskAll, MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: make([]model.WorkerProjectConfiguration, 128)}
	args := make([][]string, 128)
	for i := range value.Projects {
		args[i] = make([]string, 8)
		for j := range args[i] {
			args[i][j] = strings.Repeat("x", 4096)
		}
		value.Projects[i] = model.WorkerProjectConfiguration{ProjectID: queryID(100 + i), NativeOverrides: map[string]json.RawMessage{}}
	}
	encode := func() []byte {
		t.Helper()
		for i := range value.Projects {
			b, err := json.Marshal(args[i])
			if err != nil {
				t.Fatal(err)
			}
			value.Projects[i].NativeOverrides["args"] = b
		}
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	raw := encode()
	excess := len(raw) - workercore.MaxConfigurationJSONBytes
	if excess <= 0 {
		t.Fatalf("fixture did not exceed budget: %d", len(raw))
	}
	for i := len(args) - 1; i >= 0 && excess > 0; i-- {
		for j := len(args[i]) - 1; j >= 0 && excess > 0; j-- {
			trim := min(excess, len(args[i][j])-1)
			args[i][j] = args[i][j][:len(args[i][j])-trim]
			excess -= trim
		}
	}
	raw = encode()
	if excess != 0 || len(raw) != workercore.MaxConfigurationJSONBytes {
		t.Fatalf("fixture length=%d remainder=%d", len(raw), excess)
	}
	if _, err := workercore.ParseWorkerConfiguration(raw); err != nil {
		t.Fatalf("historical exact-limit input: %v", err)
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=1,configuration_updated_at=now(),desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, raw)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var result model.WorkerConfigurationResource
		if err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
			var err error
			result, err = s.WorkerDAO().WorkerConfiguration(ctx, user, id)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	observed := read()
	if observed.Desired == nil || !observed.Desired.ValueValid || observed.Desired.Revision != "2" || observed.Desired.Value.TaskTagFilter == nil || len(observed.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("migrated target was not readable with canonical empty filter")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(observed.Desired.Raw, &fields); err != nil {
		t.Fatal(err)
	}
	compact, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if len(compact) != workercore.MaxConfigurationJSONBytes+int(workerprotocol.EmptyTaskTagFilterMemberBytes) {
		t.Fatalf("migrated size=%d", len(compact))
	}
	old, err := workercore.ParseWorkerConfigurationProtocol(raw, workerprotocol.Capabilities{ToolPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	old.MaxConcurrent = 2
	var result model.WorkerConfigurationResource
	completion, err := db.WriteWorker(ctx, func(s store.WorkerScope) error {
		var err error
		result, err = workercore.PutConfiguration(ctx, s.WorkerDAO(), model.Principal{UserID: user}, id, 2, old)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || result.Desired.Revision != "3" {
		t.Fatalf("legacy PUT: %+v %v", completion, err)
	}
	after := read()
	if after.Desired.Revision != "3" || after.Desired.Value.MaxConcurrent != 2 || after.Desired.Value.TaskTagFilter == nil || len(after.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("legacy PUT lost empty field or edit")
	}

	// A supported Worker cannot expand a full target with a nonempty filter.
	if _, err := pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=1, configuration_observation=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, `{"baseRevision":"0","desiredRevision":"3","items":[{"key":{"kind":"taskTagFilter"},"targetRevision":"3","appliedValue":null,"state":"pending","error":null,"lastFailure":null,"nextAttemptAt":null}],"reportedAt":"2026-01-01T00:00:00Z"}`); err != nil {
		t.Fatal(err)
	}
	tooLarge := after.Desired.Value
	tooLarge.TaskTagFilter = &model.TagNameFilter{Names: []string{"backend"}, Match: "any"}
	completion, err = db.WriteWorker(ctx, func(s store.WorkerScope) error {
		_, e := workercore.PutConfiguration(ctx, s.WorkerDAO(), model.Principal{UserID: user}, id, 3, tooLarge)
		return e
	})
	var fault *model.Fault
	if err == nil || completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &fault) {
		t.Fatalf("oversized nonempty filter was not refused: %+v %v", completion, err)
	}
	unchanged := read()
	if unchanged.Desired.Revision != "3" || unchanged.Desired.Value.TaskTagFilter == nil || len(unchanged.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("failed expansion changed target")
	}
	if got := fmt.Sprint(fault.Code); got != "limit_exceeded" && got != "invalid_input" {
		t.Fatalf("unexpected fault: %s %v", got, err)
	}
}
