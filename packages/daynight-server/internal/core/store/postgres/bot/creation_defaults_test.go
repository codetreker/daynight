package bot_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestCreationReadsBoundedWorkerInputs(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	owner, target := f.candidate.OwnerUserID, f.candidate.WorkerID
	telemetry := `{"platform":"linux","machine":{"id":"host","name":"host"},"assistantHost":{"protocolVersion":1,"observedAt":"2026-11-07T00:00:00Z","defaultCwd":"/work","defaultProvider":"codex","providers":[{"provider":"codex","available":true,"reason":null,"model":"example","args":["large-argument"]}]}}`
	// Malformed snapshots and unrelated telemetry detect accidental full decoding.
	exec(t, f.tx, `UPDATE workers SET telemetry=$3::jsonb, task_snapshot='{"items":"not-an-array"}' WHERE user_id=$1 AND worker_id=$2`, owner, target, telemetry)
	for i := 0; i < 130; i++ {
		exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now()-interval '2 days',now()-interval '1 day','{"platform":123}','{"items":"not-an-array"}')`, owner, uuid.NewString())
	}
	exec(t, f.tx, `INSERT INTO bot_worker_preferences(user_id,worker_id,creation_order) VALUES($1,$2,1)`, owner, target)
	exec(t, f.tx, `INSERT INTO bot_configuration_preferences(user_id,worker_id,cwd,cwd_creation_order,provider,provider_creation_order) VALUES($1,$2,'/preferred',1,'codex',1)`, owner, target)
	exec(t, f.tx, `INSERT INTO bot_model_preferences(user_id,worker_id,provider,model,creation_order) VALUES($1,$2,'codex','chosen',1)`, owner, target)
	exec(t, f.tx, `INSERT INTO bot_effort_preferences(user_id,worker_id,provider,model,reasoning_effort,creation_order) VALUES($1,$2,'codex','chosen','high',1)`, owner, target)
	for _, reader := range []store.BotCreationReader{f.reader, f.writer} {
		preferred, err := reader.BotPreferredWorker(ctx, owner)
		if err != nil || preferred == nil || *preferred != target {
			t.Fatalf("preferred: %v %v", preferred, err)
		}
		candidate, err := reader.BotCreationCandidate(ctx, owner, target)
		if err != nil || len(candidate.Workers) != 1 || candidate.ObservedAt.IsZero() {
			t.Fatalf("candidate: %+v %v cause: %v", candidate, err, errors.Unwrap(err))
		}
		provider := candidate.Workers[0].Telemetry.AssistantHost.Providers[0]
		if provider.Model != nil || len(provider.Args) != 0 || candidate.WorkerPreferences[target].Native != nil {
			t.Fatalf("full candidate: %+v", candidate)
		}
		if pref := candidate.WorkerPreferences[target]; pref.Cwd == nil || *pref.Cwd != "/preferred" || pref.Provider == nil || *pref.Provider != "codex" {
			t.Fatalf("preferences: %+v", pref)
		}
		full, err := reader.BotCreationWorker(ctx, owner, target)
		if err != nil || len(full.Workers) != 1 {
			t.Fatalf("selected: %+v %v", full, err)
		}
		provider = full.Workers[0].Telemetry.AssistantHost.Providers[0]
		native := full.WorkerPreferences[target].Native["codex"]
		if provider.Model == nil || *provider.Model != "example" || len(provider.Args) != 1 || native.Model == nil || *native.Model != "chosen" || native.Efforts["chosen"] != "high" {
			t.Fatalf("selected: %+v %+v", provider, native)
		}
		missing, err := reader.BotCreationWorker(ctx, uuid.NewString(), target)
		if err != nil || len(missing.Workers) != 0 || len(missing.WorkerPreferences) != 0 {
			t.Fatalf("foreign worker leaked: %+v %v", missing, err)
		}
		active, err := reader.BotCreationCandidates(ctx, owner)
		if err != nil || len(active.Workers) != 1 || active.Workers[0].WorkerID != target {
			t.Fatalf("active: %+v %v", active, err)
		}
	}
	if _, err := f.reader.BotDefaults(ctx, owner); err == nil {
		t.Fatal("full directory did not decode historical data")
	}
	for i := 0; i < 105; i++ {
		exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now()+($3 * interval '1 millisecond'),now(),$4::jsonb,'{}')`, owner, uuid.NewString(), i+1, telemetry)
	}
	active, err := f.reader.BotCreationCandidates(ctx, owner)
	if err != nil || len(active.Workers) != 101 || active.Workers[0].WorkerID != target {
		t.Fatalf("bounded candidates: %d %v", len(active.Workers), err)
	}
	for i := 1; i < len(active.Workers); i++ {
		if active.Workers[i].CreatedAt.Before(active.Workers[i-1].CreatedAt) {
			t.Fatalf("order at %d", i)
		}
	}
}

func TestCreationReadFailuresReturnNoPartialData(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for name, read := range map[string]func() (model.BotDefaultsInput, error){
		"candidate": func() (model.BotDefaultsInput, error) {
			return f.reader.BotCreationCandidate(ctx, f.candidate.OwnerUserID, f.candidate.WorkerID)
		},
		"candidates": func() (model.BotDefaultsInput, error) {
			return f.reader.BotCreationCandidates(ctx, f.candidate.OwnerUserID)
		},
		"worker": func() (model.BotDefaultsInput, error) {
			return f.reader.BotCreationWorker(ctx, f.candidate.OwnerUserID, f.candidate.WorkerID)
		},
	} {
		value, err := read()
		if err == nil || !errors.Is(err, context.Canceled) || len(value.Workers) != 0 {
			t.Errorf("%s: %+v, %v", name, value, err)
		}
	}
	_, err := f.reader.BotPreferredWorker(ctx, f.candidate.OwnerUserID)
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("preferred cancellation: %v", err)
	}
}

func TestCreationCandidateFreshnessAndDecodeFailure(t *testing.T) {
	f := newFixture(t)
	owner := f.candidate.OwnerUserID
	oldID, futureID, validID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, fixture := range []struct{ id, offset string }{
		{oldID, "-120 seconds"}, {futureID, "+1 hour"}, {validID, "-119 seconds"},
	} {
		exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 VALUES($1,$2,now(),statement_timestamp()+$3::interval,'{}','{}')`, owner, fixture.id, fixture.offset)
	}
	active, err := f.reader.BotCreationCandidates(t.Context(), owner)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, worker := range active.Workers {
		seen[worker.WorkerID] = true
	}
	if seen[oldID] || seen[futureID] || !seen[validID] {
		t.Fatalf("freshness window: %v", seen)
	}
	exec(t, f.tx, `UPDATE workers SET telemetry='{"platform":123}' WHERE user_id=$1 AND worker_id=$2`, owner, validID)
	candidate, err := f.reader.BotCreationCandidates(t.Context(), owner)
	if err == nil || len(candidate.Workers) != 0 || !candidate.ObservedAt.IsZero() {
		t.Fatalf("decoding must fail without a partial result: %+v %v", candidate, err)
	}
}
