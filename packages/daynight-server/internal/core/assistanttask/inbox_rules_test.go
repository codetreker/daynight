package assistanttask

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// inboxStub adds the inbox capabilities to daoStub; unset capabilities fail.
type inboxStub struct {
	*daoStub
	current func(context.Context, string, string) (model.AssistantTaskInbox, error)
	lock    func(context.Context, string, string, string) (model.AssistantTaskInbox, error)
	insert  func(context.Context, model.AssistantTaskInbox) (bool, error)
	save    func(context.Context, model.AssistantTaskInbox, int64) (bool, error)
}

func (d *inboxStub) CurrentInbox(ctx context.Context, owner, task string) (model.AssistantTaskInbox, error) {
	return d.current(ctx, owner, task)
}
func (d *inboxStub) LockInbox(ctx context.Context, owner, task, inbox string) (model.AssistantTaskInbox, error) {
	return d.lock(ctx, owner, task, inbox)
}
func (d *inboxStub) InsertInbox(ctx context.Context, v model.AssistantTaskInbox) (bool, error) {
	return d.insert(ctx, v)
}
func (d *inboxStub) SaveInbox(ctx context.Context, v model.AssistantTaskInbox, version int64) (bool, error) {
	return d.save(ctx, v, version)
}

func digestOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func enabledInbox() model.AssistantTaskInbox {
	return model.AssistantTaskInbox{InboxID: inboxID, OwnerUserID: ownerID, TaskID: taskID, State: model.AssistantTaskInboxEnabled, TokenDigest: ptr(digestOf("current")), SuppressedCount: 3, Version: 4, CreatedAt: epoch.Add(-time.Hour)}
}

type inboxCapture struct {
	locked, saved, inserted []model.AssistantTaskInbox
	savedVersions           []int64
	tasks                   []model.AssistantTask
	conditions              []store.AssistantTaskCondition
	receipts                []model.AssistantTaskClaimOperation
}

// inboxDAO serves an existing inbox (nil for none) and an absent receipt.
func inboxDAO(t *testing.T, task model.AssistantTask, existing *model.AssistantTaskInbox) (*inboxStub, *inboxCapture) {
	t.Helper()
	c := &inboxCapture{}
	d := &inboxStub{daoStub: baseDAO(t, task)}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{}, model.ErrNotFound
	}
	d.current = func(_ context.Context, owner, id string) (model.AssistantTaskInbox, error) {
		if owner != ownerID || id != taskID {
			t.Fatalf("wrong inbox scope %s %s", owner, id)
		}
		if existing == nil {
			return model.AssistantTaskInbox{}, model.ErrNotFound
		}
		return *existing, nil
	}
	d.lock = func(_ context.Context, owner, id, inbox string) (model.AssistantTaskInbox, error) {
		if owner != ownerID || id != taskID || inbox != inboxID {
			t.Fatalf("wrong inbox lock %s %s %s", owner, id, inbox)
		}
		c.locked = append(c.locked, *existing)
		return *existing, nil
	}
	d.insert = func(_ context.Context, v model.AssistantTaskInbox) (bool, error) {
		c.inserted = append(c.inserted, v)
		return true, nil
	}
	d.save = func(_ context.Context, v model.AssistantTaskInbox, version int64) (bool, error) {
		c.saved, c.savedVersions = append(c.saved, v), append(c.savedVersions, version)
		return true, nil
	}
	d.saveTask = func(_ context.Context, v model.AssistantTask, condition store.AssistantTaskCondition) (bool, error) {
		c.tasks, c.conditions = append(c.tasks, v), append(c.conditions, condition)
		return true, nil
	}
	d.insertClaimOperation = func(_ context.Context, v model.AssistantTaskClaimOperation) error {
		c.receipts = append(c.receipts, v)
		return nil
	}
	return d, c
}

func inboxInput(mode string) InboxInput {
	return InboxInput{TaskID: taskID, OperationID: entryID, Mode: mode, IfVersion: 7}
}

func TestInboxTokensCarryPrefixEntropyAndDigest(t *testing.T) {
	first, digest, err := NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first, InboxTokenPrefix) || len(first) != len(InboxTokenPrefix)+43 || first == second || digest != digestOf(first) {
		t.Fatalf("token %q digest %q", first, digest)
	}
	for _, bad := range []string{"", first[len(InboxTokenPrefix):], "xx" + first[2:], first + "A", first[:len(first)-1] + "!", InboxTokenPrefix + strings.Repeat("_", 42) + "B"} {
		if _, err := InboxTokenDigest(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	defer func(read func([]byte) (int, error)) { randomRead = read }(randomRead)
	randomRead = func([]byte) (int, error) { return 0, sentinel }
	if _, _, err := NewInboxToken(); !errors.Is(err, sentinel) {
		t.Fatalf("entropy failure hidden: %v", err)
	}
}

func TestVerifyInboxTokenHonorsOverlapDeadline(t *testing.T) {
	current, _, _ := NewInboxToken()
	old, _, _ := NewInboxToken()
	inbox := enabledInbox()
	inbox.TokenDigest = ptr(digestOf(current))
	inbox.OverlapTokenDigest = ptr(digestOf(old))
	inbox.OverlapUntil = ptr(epoch.Add(time.Hour))
	other, _, _ := NewInboxToken()
	for _, tc := range []struct {
		name  string
		inbox model.AssistantTaskInbox
		token string
		now   time.Time
		want  bool
	}{
		{"current", inbox, current, epoch, true},
		{"overlap", inbox, old, epoch, true},
		{"overlap expired", inbox, old, epoch.Add(time.Hour), false},
		{"unknown", inbox, other, epoch, false},
		{"malformed", inbox, "current", epoch, false},
		{"tombstone", model.AssistantTaskInbox{State: model.AssistantTaskInboxTombstone}, current, epoch, false},
		{"no digests", model.AssistantTaskInbox{State: model.AssistantTaskInboxEnabled}, current, epoch, false},
	} {
		if got := VerifyInboxToken(tc.inbox, tc.token, tc.now); got != tc.want {
			t.Fatalf("%s: got %v", tc.name, got)
		}
	}
}

func TestEnableInboxCreatesInboxAndReturnsTokenOnce(t *testing.T) {
	d, c := inboxDAO(t, baseTask(), nil)
	result, err := New().EnableInbox(context.Background(), d, userActor(), inboxInput(""))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.inserted) != 1 || len(c.saved) != 0 || len(c.receipts) != 1 || len(c.tasks) != 1 {
		t.Fatalf("writes %+v", c)
	}
	inbox := c.inserted[0]
	if !strictID(inbox.InboxID) || inbox.State != model.AssistantTaskInboxEnabled || inbox.Version != 1 || inbox.TokenDigest == nil || *inbox.TokenDigest != digestOf(result.Token) || inbox.OverlapTokenDigest != nil || !inbox.CreatedAt.Equal(epoch) {
		t.Fatalf("inbox %+v", inbox)
	}
	if c.tasks[0].Version != 8 || c.conditions[0] != (store.AssistantTaskCondition{Version: 7}) {
		t.Fatalf("task fence %+v %+v", c.tasks[0], c.conditions[0])
	}
	receipt := c.receipts[0]
	if receipt.Kind != "inbox_enable" || receipt.OperationID != entryID || receipt.ResultingVersion != 8 || receipt.ActorBotID != nil || receipt.ResultingGeneration != 2 || receipt.RequestFingerprint == "" {
		t.Fatalf("receipt %+v", receipt)
	}
	if result.Operation != receipt || !result.Inbox.Enabled || result.Inbox.InboxID != inbox.InboxID || result.Inbox.OverlapUntil != nil {
		t.Fatalf("result %+v", result)
	}
}

func TestRotateInboxOverlapKeepsPreviousTokenForOneDay(t *testing.T) {
	existing := enabledInbox()
	d, c := inboxDAO(t, baseTask(), &existing)
	result, err := New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateOverlap))
	if err != nil {
		t.Fatal(err)
	}
	saved := c.saved[0]
	if len(c.locked) != 1 || c.savedVersions[0] != 4 || saved.Version != 5 || *saved.TokenDigest != digestOf(result.Token) || *saved.OverlapTokenDigest != digestOf("current") || !saved.OverlapUntil.Equal(epoch.Add(24*time.Hour)) || !saved.RotatedAt.Equal(epoch) {
		t.Fatalf("saved %+v", saved)
	}
	if c.receipts[0].Kind != "inbox_rotate_overlap" || !result.Inbox.OverlapUntil.Equal(epoch.Add(24*time.Hour)) || result.Inbox.SuppressedCount != 3 {
		t.Fatalf("result %+v", result)
	}
}

func TestRotateInboxRefusesSecondOverlapButAllowsImmediate(t *testing.T) {
	existing := enabledInbox()
	existing.OverlapTokenDigest = ptr(digestOf("older"))
	existing.OverlapUntil = ptr(epoch.Add(time.Minute))
	d, c := inboxDAO(t, baseTask(), &existing)
	_, err := New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateOverlap))
	requireCode(t, err, "invalid_transition")
	if len(c.saved) != 0 || len(c.receipts) != 0 {
		t.Fatal("refused rotation wrote state")
	}
	result, err := New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateImmediate))
	if err != nil {
		t.Fatal(err)
	}
	saved := c.saved[0]
	if saved.OverlapTokenDigest != nil || saved.OverlapUntil != nil || *saved.TokenDigest != digestOf(result.Token) || c.receipts[0].Kind != "inbox_rotate_immediate" || result.Inbox.OverlapUntil != nil {
		t.Fatalf("saved %+v result %+v", saved, result)
	}
	// An expired overlap no longer blocks an overlap rotation.
	existing.OverlapUntil = ptr(epoch)
	d, _ = inboxDAO(t, baseTask(), &existing)
	if _, err = New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateOverlap)); err != nil {
		t.Fatal(err)
	}
}

func TestDisableInboxLeavesTombstoneWithoutToken(t *testing.T) {
	existing := enabledInbox()
	existing.OverlapTokenDigest = ptr(digestOf("older"))
	existing.OverlapUntil = ptr(epoch.Add(time.Hour))
	d, c := inboxDAO(t, baseTask(), &existing)
	result, err := New().DisableInbox(context.Background(), d, userActor(), inboxInput(""))
	if err != nil {
		t.Fatal(err)
	}
	saved := c.saved[0]
	if saved.State != model.AssistantTaskInboxTombstone || saved.TokenDigest != nil || saved.OverlapTokenDigest != nil || saved.OverlapUntil != nil || saved.InboxID != inboxID || saved.Version != 5 {
		t.Fatalf("saved %+v", saved)
	}
	if result.Token != "" || result.Inbox != (InboxView{}) || c.receipts[0].Kind != "inbox_disable" {
		t.Fatalf("result %+v", result)
	}
}

func TestInboxManagementRejectsInvalidRequestsBeforeWriting(t *testing.T) {
	existing := enabledInbox()
	deleted := baseTask()
	deleted.State = "deleted"
	for _, tc := range []struct {
		name  string
		actor Actor
		run   func(*Module, store.AssistantTaskDAO, Actor) error
		task  model.AssistantTask
		inbox *model.AssistantTaskInbox
		code  string
	}{
		{"bot enable", botActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, inboxInput(""))
			return err
		}, baseTask(), nil, "forbidden"},
		{"bot read", botActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.GetInbox(context.Background(), d, a, taskID)
			return err
		}, baseTask(), nil, "forbidden"},
		{"bot receipt", botActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.InboxOperation(context.Background(), d, a, taskID, entryID)
			return err
		}, baseTask(), nil, "forbidden"},
		{"mode", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.RotateInbox(context.Background(), d, a, inboxInput("later"))
			return err
		}, baseTask(), &existing, "invalid_input"},
		{"operation id", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, InboxInput{TaskID: taskID, OperationID: "x", IfVersion: 7})
			return err
		}, baseTask(), nil, "invalid_input"},
		{"version missing", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, InboxInput{TaskID: taskID, OperationID: entryID})
			return err
		}, baseTask(), nil, "invalid_input"},
		{"version stale", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, InboxInput{TaskID: taskID, OperationID: entryID, IfVersion: 6})
			return err
		}, baseTask(), nil, "version_conflict"},
		{"deleted task", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, inboxInput(""))
			return err
		}, deleted, nil, "task_deleted"},
		{"enable twice", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.EnableInbox(context.Background(), d, a, inboxInput(""))
			return err
		}, baseTask(), &existing, "invalid_transition"},
		{"disable absent", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.DisableInbox(context.Background(), d, a, inboxInput(""))
			return err
		}, baseTask(), nil, "invalid_transition"},
		{"rotate absent", userActor(), func(m *Module, d store.AssistantTaskDAO, a Actor) error {
			_, err := m.RotateInbox(context.Background(), d, a, inboxInput(InboxRotateImmediate))
			return err
		}, baseTask(), nil, "invalid_transition"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, c := inboxDAO(t, tc.task, tc.inbox)
			requireCode(t, tc.run(New(), d, tc.actor), tc.code)
			if len(c.saved)+len(c.inserted)+len(c.receipts)+len(c.tasks) != 0 {
				t.Fatalf("rejected request wrote %+v", c)
			}
		})
	}
}

func TestInboxReplayReturnsReceiptWithoutToken(t *testing.T) {
	existing := enabledInbox()
	d, c := inboxDAO(t, baseTask(), &existing)
	first, err := New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateImmediate))
	if err != nil {
		t.Fatal(err)
	}
	saved := c.receipts[0]
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return saved, nil
	}
	task := baseTask()
	task.Version = 8
	d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) { return task, nil }
	replay, err := New().RotateInbox(context.Background(), d, userActor(), inboxInput(InboxRotateImmediate))
	if err != nil {
		t.Fatal(err)
	}
	if replay.Token != "" || replay.Operation != first.Operation || replay.Inbox.InboxID != inboxID || len(c.receipts) != 1 {
		t.Fatalf("replay %+v", replay)
	}
	read, err := New().InboxOperation(context.Background(), d, userActor(), taskID, entryID)
	if err != nil || read.Token != "" || read.Operation != saved {
		t.Fatalf("read %+v %v", read, err)
	}
	// The same operation ID with another inbox request is a conflict.
	_, err = New().DisableInbox(context.Background(), d, userActor(), inboxInput(""))
	requireCode(t, err, "operation_conflict")
	// Claim receipts and inbox receipts are not readable through each other.
	claim := saved
	claim.Kind = "claim"
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return claim, nil
	}
	if _, err = New().InboxOperation(context.Background(), d, userActor(), taskID, entryID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("claim receipt exposed: %v", err)
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return saved, nil
	}
	if _, err = New().ClaimOperation(context.Background(), d, userActor(), taskID, entryID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("inbox receipt exposed as claim: %v", err)
	}
	if _, err = New().InboxOperation(context.Background(), d, userActor(), taskID, "x"); err == nil {
		t.Fatal("accepted invalid operation ID")
	}
}

func TestGetInboxReadsStateWithoutSecrets(t *testing.T) {
	existing := enabledInbox()
	existing.OverlapTokenDigest = ptr(digestOf("older"))
	existing.OverlapUntil = ptr(epoch.Add(-time.Second))
	d, _ := inboxDAO(t, baseTask(), &existing)
	view, err := New().GetInbox(context.Background(), d, userActor(), taskID)
	if err != nil {
		t.Fatal(err)
	}
	if view.InboxID != inboxID || !view.Enabled || !view.CreatedAt.Equal(existing.CreatedAt) || view.OverlapUntil != nil || view.SuppressedCount != 3 {
		t.Fatalf("view %+v", view)
	}
	d, _ = inboxDAO(t, baseTask(), nil)
	if view, err = New().GetInbox(context.Background(), d, userActor(), taskID); err != nil || view != (InboxView{}) {
		t.Fatalf("absent %+v %v", view, err)
	}
	d.current = func(context.Context, string, string) (model.AssistantTaskInbox, error) {
		return model.AssistantTaskInbox{}, sentinel
	}
	if _, err = New().GetInbox(context.Background(), d, userActor(), taskID); !errors.Is(err, sentinel) {
		t.Fatalf("read failure hidden: %v", err)
	}
	if _, err = New().InboxOperation(context.Background(), &inboxStub{daoStub: d.daoStub, current: d.current}, userActor(), taskID, entryID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("absent receipt: %v", err)
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{Kind: "inbox_enable"}, nil
	}
	if _, err = New().InboxOperation(context.Background(), d, userActor(), taskID, entryID); !errors.Is(err, sentinel) {
		t.Fatalf("receipt inbox failure hidden: %v", err)
	}
	if _, err = New().GetInbox(context.Background(), d, userActor(), "x"); err == nil {
		t.Fatal("accepted invalid task ID")
	}
	if _, err = New().InboxOperation(context.Background(), d, userActor(), "x", entryID); err == nil {
		t.Fatal("accepted invalid task ID")
	}
}

func TestInboxManagementReturnsStorageFailures(t *testing.T) {
	fail := func(context.Context) (time.Time, error) { return time.Time{}, sentinel }
	for _, tc := range []struct {
		name   string
		mode   string
		inbox  bool
		mutate func(*inboxStub)
		want   error
	}{
		{"receipt read", InboxRotateImmediate, true, func(d *inboxStub) {
			d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
				return model.AssistantTaskClaimOperation{}, sentinel
			}
		}, sentinel},
		{"current", InboxRotateImmediate, true, func(d *inboxStub) {
			d.current = func(context.Context, string, string) (model.AssistantTaskInbox, error) {
				return model.AssistantTaskInbox{}, sentinel
			}
		}, sentinel},
		{"lock", InboxRotateImmediate, true, func(d *inboxStub) {
			d.lock = func(context.Context, string, string, string) (model.AssistantTaskInbox, error) {
				return model.AssistantTaskInbox{}, sentinel
			}
		}, sentinel},
		{"now", InboxRotateImmediate, true, func(d *inboxStub) { d.now = fail }, sentinel},
		{"insert", "enable", false, func(d *inboxStub) {
			d.insert = func(context.Context, model.AssistantTaskInbox) (bool, error) { return false, sentinel }
		}, sentinel},
		{"insert collision", "enable", false, func(d *inboxStub) {
			d.insert = func(context.Context, model.AssistantTaskInbox) (bool, error) { return false, nil }
		}, nil},
		{"save", InboxRotateImmediate, true, func(d *inboxStub) {
			d.save = func(context.Context, model.AssistantTaskInbox, int64) (bool, error) { return false, sentinel }
		}, sentinel},
		{"save conflict", "disable", true, func(d *inboxStub) {
			d.save = func(context.Context, model.AssistantTaskInbox, int64) (bool, error) { return false, nil }
		}, nil},
		{"task save", InboxRotateOverlap, true, func(d *inboxStub) {
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				return false, sentinel
			}
		}, sentinel},
		{"receipt write", InboxRotateImmediate, true, func(d *inboxStub) {
			d.insertClaimOperation = func(context.Context, model.AssistantTaskClaimOperation) error { return sentinel }
		}, sentinel},
		{"final admission", InboxRotateImmediate, true, func(d *inboxStub) {
			calls := 0
			d.credential = func(context.Context, model.Principal) error {
				if calls++; calls > 1 {
					return sentinel
				}
				return nil
			}
		}, sentinel},
		{"inbox version exhausted", InboxRotateImmediate, true, func(d *inboxStub) {
			d.lock = func(context.Context, string, string, string) (model.AssistantTaskInbox, error) {
				v := enabledInbox()
				v.Version = math.MaxInt64
				return v, nil
			}
		}, nil},
		{"disable version exhausted", "disable", true, func(d *inboxStub) {
			d.lock = func(context.Context, string, string, string) (model.AssistantTaskInbox, error) {
				v := enabledInbox()
				v.Version = math.MaxInt64
				return v, nil
			}
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var existing *model.AssistantTaskInbox
			if tc.inbox {
				v := enabledInbox()
				existing = &v
			}
			d, _ := inboxDAO(t, baseTask(), existing)
			tc.mutate(d)
			m := New()
			var err error
			switch tc.mode {
			case "enable":
				_, err = m.EnableInbox(context.Background(), d, userActor(), inboxInput(""))
			case "disable":
				_, err = m.DisableInbox(context.Background(), d, userActor(), inboxInput(""))
			default:
				_, err = m.RotateInbox(context.Background(), d, userActor(), inboxInput(tc.mode))
			}
			if err == nil || tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestEnableInboxReturnsEntropyFailure(t *testing.T) {
	defer func(read func([]byte) (int, error)) { randomRead = read }(randomRead)
	randomRead = func([]byte) (int, error) { return 0, sentinel }
	d, c := inboxDAO(t, baseTask(), nil)
	if _, err := New().EnableInbox(context.Background(), d, userActor(), inboxInput("")); !errors.Is(err, sentinel) || len(c.inserted) != 0 {
		t.Fatalf("got %v", err)
	}
}
