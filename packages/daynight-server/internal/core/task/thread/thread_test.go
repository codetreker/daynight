package thread

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

var errStorage = errors.New("storage failure")

type threadFixture struct {
	fail     string
	valid    bool
	current  model.Task
	events   []string
	messages []model.ThreadMessage
	anchor   *model.ThreadPosition
	before   bool
	limit    int
	cancel   context.CancelFunc
}

func (f *threadFixture) record(stage string) error {
	f.events = append(f.events, stage)
	if f.fail == stage {
		return errStorage
	}
	return nil
}
func (f *threadFixture) LockTaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	panic("unexpected")
}
func (f *threadFixture) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	panic("unexpected")
}
func (f *threadFixture) SourceTask(context.Context, string, string) (model.Task, error) {
	return f.current, f.record("source")
}
func (f *threadFixture) AuthorName(context.Context, string) (*string, error) {
	name := "Alice"
	return &name, f.record("author")
}
func (f *threadFixture) CredentialValid(context.Context, store.ThreadCredential) (bool, error) {
	return f.valid, f.record("credential")
}
func (f *threadFixture) LockHead(context.Context, string) (*model.ThreadPosition, error) {
	return nil, f.record("head")
}
func (f *threadFixture) ThreadMessage(context.Context, string, string) (model.ThreadMessage, error) {
	if f.fail == "missing" {
		return model.ThreadMessage{}, model.ErrNotFound
	}
	if err := f.record("message"); err != nil {
		return model.ThreadMessage{}, err
	}
	return model.ThreadMessage{ID: "anchor", CreatedAt: time.Unix(1, 0)}, nil
}
func (f *threadFixture) InsertMessage(_ context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
	if err := f.record("insert"); err != nil {
		return model.ThreadMessage{}, err
	}
	message.ID, message.CreatedAt = "candidate", time.Unix(2, 0)
	return message, nil
}
func (f *threadFixture) PrepareTimestamp(context.Context, *model.ThreadMessage, *model.ThreadPosition) error {
	return f.record("timestamp")
}
func (f *threadFixture) AdvanceHead(context.Context, string, model.ThreadPosition) error {
	err := f.record("advance")
	if f.cancel != nil {
		f.cancel()
	}
	return err
}
func (f *threadFixture) ThreadCandidates(_ context.Context, _ string, anchor *model.ThreadPosition, before bool, limit int) ([]model.ThreadMessage, error) {
	f.anchor, f.before, f.limit = anchor, before, limit
	return f.messages, f.record("candidates")
}
func (f *threadFixture) ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error) {
	err := f.record("sides")
	if f.cancel != nil {
		f.cancel()
	}
	return true, false, err
}

func activeTask(t *testing.T, user string) (model.Task, string) {
	t.Helper()
	claim := model.WorkerClaim{ClaimID: "00000000-0000-4000-8000-000000000001", State: model.WorkerActive, UserID: user, WorkerID: "00000000-0000-4000-8000-000000000003", Machine: model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000004", Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "00000000-0000-4000-8000-000000000005", Phase: model.WorkerExecuting, ClaimedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	value, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	return model.Task{Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": value}}, claim.ClaimID
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestAppendAttributionAndOrderedAdmission(t *testing.T) {
	user := "00000000-0000-4000-8000-000000000002"
	current, claim := activeTask(t, user)
	f := &threadFixture{valid: true, current: current}
	reply := "existing"
	message, encoded, err := Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", "hello", &reply, &claim, store.ThreadCredential{})
	if err != nil || len(encoded) == 0 || message.ID != "candidate" || !message.Author.Agent || message.Author.Execution == nil || message.Author.Execution.ClaimID != claim || message.Author.DisplayName == nil || *message.Author.DisplayName != "Alice" {
		t.Fatalf("message: %+v %s %v", message, encoded, err)
	}
	if !reflect.DeepEqual(f.events, []string{"author", "source", "head", "message", "insert", "timestamp", "credential", "advance"}) {
		t.Fatalf("admission order: %v", f.events)
	}
	f = &threadFixture{valid: true, current: current}
	_, _, err = Append(context.Background(), f, f, f, model.Principal{UserID: "other"}, "project", "task", "hello", nil, &claim, store.ThreadCredential{})
	requireCode(t, err, "forbidden")
	if len(f.events) != 2 {
		t.Fatalf("non-owner reached write: %v", f.events)
	}
	f = &threadFixture{valid: true, current: current}
	wrong := "00000000-0000-4000-8000-000000000099"
	_, _, err = Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", "hello", nil, &wrong, store.ThreadCredential{})
	requireCode(t, err, "claim_conflict")
}

func TestAppendFailureRetainsCandidateAndNeverAdvancesEarly(t *testing.T) {
	user := "00000000-0000-4000-8000-000000000002"
	current, claim := activeTask(t, user)
	reply := "existing"
	for _, stage := range []string{"author", "source", "head", "message", "insert", "timestamp", "credential", "advance"} {
		t.Run(stage, func(t *testing.T) {
			f := &threadFixture{valid: true, current: current, fail: stage}
			message, encoded, err := Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", "body", &reply, &claim, store.ThreadCredential{})
			if !errors.Is(err, errStorage) || encoded != nil {
				t.Fatalf("failure: %+v %v", message, err)
			}
			if stage != "advance" && slices.Contains(f.events, "advance") {
				t.Fatalf("failure at %s still advanced head: %v", stage, f.events)
			}
			if (stage == "timestamp" || stage == "credential" || stage == "advance") && (message.ID != "candidate" || message.Author.Execution == nil) {
				t.Fatalf("lost diagnostic candidate: %+v", message)
			}
		})
	}
	f := &threadFixture{valid: true, current: current, fail: "missing"}
	_, _, err := Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", "body", &reply, &claim, store.ThreadCredential{})
	requireCode(t, err, "message_not_found")
	f = &threadFixture{current: current}
	message, _, err := Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", "body", nil, nil, store.ThreadCredential{})
	requireCode(t, err, "unauthenticated")
	if message.ID != "candidate" || f.events[len(f.events)-1] != "credential" {
		t.Fatalf("expired credential reached head advance: %+v %v", message, f.events)
	}
	f = &threadFixture{valid: true, current: current}
	_, _, err = Append(context.Background(), f, f, f, model.Principal{UserID: user}, "project", "task", strings.Repeat("x", taskcodec.MessageLimit), nil, nil, store.ThreadCredential{})
	requireCode(t, err, "payload_too_large")
	ctx, cancel := context.WithCancel(context.Background())
	f = &threadFixture{valid: true, current: current, cancel: cancel}
	_, _, err = Append(ctx, f, f, f, model.Principal{UserID: user}, "project", "task", "body", nil, nil, store.ThreadCredential{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestReadPageBoundariesAndFailures(t *testing.T) {
	messages := []model.ThreadMessage{{ID: "newer", Body: "two", CreatedAt: time.Unix(2, 0)}, {ID: "older", Body: "one", CreatedAt: time.Unix(1, 0)}}
	id := "anchor"
	f := &threadFixture{messages: messages}
	page, encoded, err := ReadPage(context.Background(), f, "task", PageRequest{BeforeID: &id, Count: 2})
	if err != nil || len(encoded) == 0 || len(page.Items) != 2 || page.Items[0].ID != "older" || !page.HasMoreBefore || page.HasMoreAfter || f.anchor == nil || f.anchor.ID != "anchor" || !f.before || f.limit != 3 {
		t.Fatalf("page: %+v %s %v", page, encoded, err)
	}
	f = &threadFixture{messages: messages}
	_, _, err = ReadPage(context.Background(), f, "task", PageRequest{AfterID: &id, Count: 1})
	if err != nil || f.before {
		t.Fatalf("forward page: %v", err)
	}
	for _, stage := range []string{"message", "candidates", "sides"} {
		f = &threadFixture{messages: messages, fail: stage}
		_, _, err = ReadPage(context.Background(), f, "task", PageRequest{BeforeID: &id, Count: 2})
		if !errors.Is(err, errStorage) {
			t.Fatalf("%s: %v", stage, err)
		}
	}
	f = &threadFixture{fail: "missing"}
	_, _, err = ReadPage(context.Background(), f, "task", PageRequest{BeforeID: &id, Count: 1})
	requireCode(t, err, "message_not_found")
	f = &threadFixture{}
	page, encoded, err = ReadPage(context.Background(), f, "task", PageRequest{Count: 1, FromBeginning: true})
	if err != nil || page.Items == nil || page.HasMoreBefore || page.HasMoreAfter || len(encoded) == 0 || f.before {
		t.Fatalf("empty: %+v %v", page, err)
	}
}

func TestPageAndMessageValidationAndBudgets(t *testing.T) {
	id := "ABCDEF00-0000-4000-8000-000000000001"
	reply, claim, err := ValidateMessage("hello", &id, &id)
	if err != nil || *reply != "abcdef00-0000-4000-8000-000000000001" || *claim != *reply {
		t.Fatalf("canonical: %v %v %v", reply, claim, err)
	}
	for _, body := range []string{" ", "x\x00", string([]byte{0xff})} {
		_, _, err = ValidateMessage(body, nil, nil)
		requireCode(t, err, "invalid_input")
	}
	_, _, err = ValidateMessage(strings.Repeat("x", taskcodec.MessageLimit+1), nil, nil)
	requireCode(t, err, "payload_too_large")
	bad := "invalid"
	if _, _, err = ValidateMessage("body", &bad, nil); err == nil {
		t.Fatal("invalid reply accepted")
	}
	if _, _, err = ValidateMessage("body", nil, &bad); err == nil {
		t.Fatal("invalid claim accepted")
	}
	request, err := ValidatePage(PageRequest{BeforeID: &id})
	if err != nil || request.Count != 50 || *request.BeforeID != *reply {
		t.Fatalf("page validation: %+v %v", request, err)
	}
	for _, input := range []PageRequest{{Count: 101}, {Count: -1}, {BeforeID: &id, AfterID: &id}, {FromBeginning: true, BeforeID: &id}, {BeforeID: &bad}, {AfterID: &bad}} {
		if _, err := ValidatePage(input); err == nil {
			t.Fatalf("accepted %+v", input)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := AdmitMessage(ctx, model.ThreadMessage{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("admission cancellation: %v", err)
	}
	if _, err := SelectPage(ctx, []model.ThreadMessage{{}}, 1, false, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("page cancellation: %v", err)
	}
	huge := model.ThreadMessage{Body: strings.Repeat("x", taskcodec.PageLimit)}
	if _, err := SelectPage(context.Background(), []model.ThreadMessage{huge}, 1, false, false); err == nil {
		t.Fatal("oversized stored message accepted")
	}
	body := strings.Repeat("x", taskcodec.MessageLimit-200)
	items := []model.ThreadMessage{{ID: "1", Body: body}, {ID: "2", Body: body}, {ID: "3", Body: body}, {ID: "4", Body: body}, {ID: "5", Body: body}}
	page, err := SelectPage(context.Background(), items, 5, false, false)
	if err != nil || len(page.Items) != 4 {
		t.Fatalf("byte budget: %d %v", len(page.Items), err)
	}
}

type cancelOnSecondCheck struct {
	context.Context
	checks int
}

func (ctx *cancelOnSecondCheck) Err() error {
	ctx.checks++
	if ctx.checks >= 2 {
		return context.Canceled
	}
	return nil
}

func TestAdmissionRejectsDetailedOverflowAndLateCancellation(t *testing.T) {
	message := model.ThreadMessage{ID: "id", Author: model.ThreadAuthor{UserID: "author", Agent: true, Execution: &model.ThreadExecution{ClaimID: "claim", WorkerID: "worker", Provider: "codex"}}, Body: "x"}
	normal, err := taskcodec.EncodeMessage(message, false)
	if err != nil {
		t.Fatal(err)
	}
	message.Body = strings.Repeat("x", taskcodec.MessageLimit-len(normal)+1)
	normal, err = taskcodec.EncodeMessage(message, false)
	if err != nil || len(normal) != taskcodec.MessageLimit {
		t.Fatalf("normal size: %d %v", len(normal), err)
	}
	_, err = AdmitMessage(context.Background(), message)
	requireCode(t, err, "payload_too_large")
	ctx := &cancelOnSecondCheck{Context: context.Background()}
	if _, err := AdmitMessage(ctx, model.ThreadMessage{Body: "body"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("late cancellation: %v", err)
	}
}

func TestReadPageRejectsOversizeAndLateCancellation(t *testing.T) {
	huge := model.ThreadMessage{ID: "id", Body: strings.Repeat("x", taskcodec.PageLimit)}
	f := &threadFixture{messages: []model.ThreadMessage{huge}}
	_, encoded, err := ReadPage(context.Background(), f, "task", PageRequest{Count: 1})
	if err == nil || encoded != nil {
		t.Fatalf("oversize accepted: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f = &threadFixture{messages: []model.ThreadMessage{{ID: "id", Body: "hello"}}, cancel: cancel}
	_, encoded, err = ReadPage(ctx, f, "task", PageRequest{Count: 1})
	if !errors.Is(err, context.Canceled) || encoded != nil {
		t.Fatalf("late cancellation: %v", err)
	}
}

func TestSelectPageRejectsCancellationAfterSelection(t *testing.T) {
	ctx := &cancelOnSecondCheck{Context: context.Background()}
	page, err := SelectPage(ctx, []model.ThreadMessage{{ID: "id", Body: "body"}}, 1, false, false)
	if !errors.Is(err, context.Canceled) || page.Items != nil {
		t.Fatalf("late cancellation: %+v %v", page, err)
	}
}
