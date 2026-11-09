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

func TestBindingAndIdentity(t *testing.T) {
	const user = "5dc7097e-78ce-4a46-8246-5e79e5a9140d"
	const credential = "3d29c454-ad6b-47d7-b476-a31295bc9d0c"
	actor := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	b := Binding{ID: user, ProjectID: user, TaskID: credential, Direction: "upload", Path: "a", ContentType: "text/plain", Parameters: []byte(`{"n":1.0,"nested":[true,2e2]}`)}
	now := time.Unix(100, 0)
	if err := ValidateActor(actor); err != nil {
		t.Fatal(err)
	}
	r, err := NewRecord(actor, b, now)
	if err != nil || r.State != "receiving" || !r.ExpiresAt.Equal(now.Add(IdleLifetime)) {
		t.Fatalf("new record %+v %v", r, err)
	}
	if !SameBinding(r, actor, b, []byte(`{"nested":[true,200],"n":1}`)) || !OwnedBy(r, actor) {
		t.Fatal("equivalent binding not accepted")
	}
	if SameBinding(r, actor, b, []byte(`{"nested":[false,200],"n":1}`)) || SameBinding(r, actor, b, []byte(`{`)) {
		t.Fatal("different or invalid binding accepted")
	}
	changed := actor
	changed.AuthorityID = user
	if OwnedBy(r, changed) || ValidateActor(changed) != ErrConflict {
		t.Fatal("wrong PAT authority")
	}
	changed.Principal.Kind = model.OAuthCredential
	changed.AuthorityKind = "oauth"
	if err := ValidateActor(changed); err != nil {
		t.Fatalf("valid OAuth authority %v", err)
	}
	changed.AuthorityKind = "other"
	if ValidateActor(changed) != ErrConflict {
		t.Fatal("invalid authority")
	}
	changed = Actor{}
	if ValidateActor(changed) == nil {
		t.Fatal("missing principal")
	}
	changed = actor
	changed.AuthorityID = "bad"
	if ValidateActor(changed) != ErrConflict {
		t.Fatal("bad id")
	}
	b.Direction = "download"
	download, err := NewRecord(actor, b, now)
	if err != nil || download.State != "preparing" {
		t.Fatalf("download %+v %v", download, err)
	}
	b.Direction = "invalid"
	if _, err = NewRecord(actor, b, now); err != ErrConflict {
		t.Fatal("bad direction")
	}
	b.Direction = "upload"
	b.Parameters = []byte(`{`)
	if _, err = NewRecord(actor, b, now); err != ErrConflict {
		t.Fatal("bad params")
	}
	if v, err := NormalizeJSON(nil); err != nil || string(v) != "{}" {
		t.Fatalf("empty params %s %v", v, err)
	}
	if _, err = NormalizeJSON([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestLifecycleStateGraphAndReceipts(t *testing.T) {
	states := map[string][]string{"receiving": {"receiving", "committing"}, "preparing": {"preparing", "readable", "failed"}, "readable": {"readable"}, "committing": {"committing", "committed", "failed", "unknown"}, "unknown": {"unknown", "committed", "failed"}, "closed": {}}
	all := []string{"receiving", "preparing", "readable", "committing", "committed", "failed", "unknown", "cleanup_pending", "closed"}
	for from, permitted := range states {
		for _, to := range all {
			want := false
			for _, allowed := range permitted {
				if allowed == to {
					want = true
				}
			}
			if Allowed(from, to) != want {
				t.Errorf("%s -> %s", from, to)
			}
		}
	}
	for _, s := range all {
		want := s == "receiving" || s == "preparing" || s == "readable" || s == "committing"
		if ContentState(s) != want {
			t.Errorf("content %s", s)
		}
	}
	for _, state := range []string{"failed", "committed", "cleanup_pending"} {
		if Allowed(state, "receiving") {
			t.Errorf("%s transfer can restart", state)
		}
	}
	if OperationID([]byte(`{"operationId":2}`)) != "" {
		t.Fatal("invalid operation id")
	}
	now := time.Unix(100, 0)
	op := json.RawMessage(`{"operationId":"5dc7097e-78ce-4a46-8246-5e79e5a9140d"}`)
	r := model.PrivateTransfer{State: "committing", Data: op, Version: 2, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(time.Hour)}
	if got, pending, err := FinishCommit(r, 2, "failed", op); err != nil || pending || got.State != "failed" || got.LeaseUntil != nil {
		t.Fatalf("finish %+v %v", got, err)
	}
	if _, _, err := FinishCommit(r, 2, "unknown", op); err != ErrState {
		t.Fatal("bad result")
	}
	pending := r
	pending.State = "cleanup_pending"
	if _, _, err := FinishCommit(pending, 2, "failed", op); err != ErrState {
		t.Fatal("missing origin")
	}
	bad := "receiving"
	pending.CleanupFromState = &bad
	if _, _, err := FinishCommit(pending, 2, "failed", op); err != ErrState {
		t.Fatal("invalid origin")
	}
	r.State = "readable"
	if _, _, err := FinishCommit(r, 2, "failed", op); err != ErrState {
		t.Fatal("non commit result")
	}
	r.State = "receiving"
	if _, err := Transition(r, 2, "committing", op, nil, now); err != ErrState {
		t.Fatal("missing lease")
	}
	if len(CleanupSteps(r, now, true)) != 0 {
		t.Fatal("unexpired cleanup")
	}
	r.ExpiresAt = now
	if got := CleanupSteps(r, now, true); len(got) != 1 || got[0].State != "cleanup_pending" {
		t.Fatal("expired cleanup")
	}
	r.State = "closed"
	if len(CleanupSteps(r, now, false)) != 0 {
		t.Fatal("closed cleanup")
	}
	if !PendingCleanup(pending) || !FinishStateValid("failed") || FinishStateValid("unknown") {
		t.Fatal("state predicates")
	}
}
