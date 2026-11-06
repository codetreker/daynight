package mcptransfer

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTransitionAndLateReceipt(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	operation := json.RawMessage(`{"operationId":"5dc7097e-78ce-4a46-8246-5e79e5a9140d"}`)
	other := json.RawMessage(`{"operationId":"3d29c454-ad6b-47d7-b476-a31295bc9d0c"}`)
	r := model.PrivateTransfer{State: "receiving", Version: 7, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(24 * time.Hour)}
	lease := now.Add(time.Minute)
	committing, err := Transition(r, 7, "committing", operation, &lease, now)
	if err != nil || committing.State != "committing" {
		t.Fatalf("commit: %+v %v", committing, err)
	}
	if _, err := Transition(committing, 7, "committed", other, nil, now); err != ErrState {
		t.Fatalf("foreign operation: %v", err)
	}
	if _, err := Transition(r, 6, "committing", operation, &lease, now); err != ErrState {
		t.Fatalf("stale version: %v", err)
	}
	steps := CleanupSteps(committing, now, false)
	if len(steps) != 2 || steps[0].State != "unknown" || steps[1].State != "cleanup_pending" {
		t.Fatalf("cleanup: %+v", steps)
	}
	pending := steps[1]
	from := "unknown"
	pending.CleanupFromState = &from
	got, isPending, err := FinishCommit(pending, 0, "committed", operation)
	if err != nil || !isPending || got.State != "cleanup_pending" || *got.CleanupFromState != "committed" {
		t.Fatalf("late receipt: %+v %t %v", got, isPending, err)
	}
	if _, _, err = FinishCommit(pending, 0, "committed", other); err != ErrState {
		t.Fatalf("foreign late receipt: %v", err)
	}
	if got := CleanupSteps(committing, now, true); len(got) != 0 {
		t.Fatalf("live lease: %+v", got)
	}
	if got := CleanupSteps(committing, lease, true); len(got) != 2 {
		t.Fatalf("expired lease: %+v", got)
	}
}

func TestCapacityAndDeadlineBoundaries(t *testing.T) {
	if !CapacityAvailable(100, 10, 70, 20) || CapacityAvailable(100, 10, 70, 21) || CapacityAvailable(9, 10, 0, 0) {
		t.Fatal("incorrect capacity boundary")
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r := model.PrivateTransfer{State: "receiving", ExpiresAt: now.Add(time.Minute), HardExpiresAt: now.Add(30 * time.Minute)}
	if !Live(r, now) || Live(r, r.ExpiresAt) {
		t.Fatal("incorrect expiry")
	}
	if got := Renew(r, now).ExpiresAt; !got.Equal(r.HardExpiresAt) {
		t.Fatalf("renewal exceeded hard deadline: %s", got)
	}
}
