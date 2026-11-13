package assistanttask

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const ownerID = "11111111-1111-4111-8111-111111111111"
const taskID = "22222222-2222-4222-8222-222222222222"
const operationID = "33333333-3333-4333-8333-333333333333"
const botID = "44444444-4444-4444-8444-444444444444"
const targetID = "55555555-5555-4555-8555-555555555555"
const entryID = "66666666-6666-4666-8666-666666666666"
const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const tokenHash = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"

var epoch = time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
var sentinel = errors.New("controlled storage failure")

func userActor() Actor {
	return Actor{Principal: model.Principal{UserID: ownerID, CredentialID: operationID, Kind: model.PATCredential}}
}
func botActor() Actor { a := userActor(); a.BotID = ptr(botID); return a }
func baseTask() model.AssistantTask {
	return model.AssistantTask{ID: taskID, OwnerUserID: ownerID, Name: "Task", Purpose: "Purpose", Scope: "Scope", Kind: "continuous", State: "active", Takeover: "manual", Version: 7, ManualVersion: 1, ClaimGeneration: 2, HolderBotID: ptr(botID), ClaimTokenHash: ptr(tokenHash), CredentialOperationID: ptr(operationID), ClaimedAt: ptr(epoch.Add(-time.Minute)), RenewedAt: ptr(epoch.Add(-time.Minute)), LeaseUntil: ptr(epoch.Add(4 * time.Minute)), CreatedAt: epoch.Add(-time.Hour), UpdatedAt: epoch, ObservedAt: epoch, Trigger: json.RawMessage("null")}
}

func savedFingerprint(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func mutation() Mutation {
	return Mutation{TaskID: taskID, ID: entryID, ClaimGeneration: 2, ClaimToken: token, IfVersion: 7}
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

// The embedded interface makes every unconfigured capability fail immediately.
// Captured writes are proposed values, never a simulated persistent database.
type daoStub struct {
	store.AssistantTaskDAO
	credential           func(context.Context, model.Principal) error
	bot                  func(context.Context, string) (model.Bot, error)
	now                  func(context.Context) (time.Time, error)
	lockCreation         func(context.Context, string) error
	task                 func(context.Context, string, string, bool) (model.AssistantTask, error)
	tasks                func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTask, error)
	insertTask           func(context.Context, model.AssistantTask) (bool, error)
	saveTask             func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error)
	deleteTaskContent    func(context.Context, string, string) error
	claimOperation       func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error)
	insertClaimOperation func(context.Context, model.AssistantTaskClaimOperation) error
	manual               func(context.Context, string, string, int64) (model.AssistantTaskManual, error)
	manuals              func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskManual, error)
	insertManual         func(context.Context, model.AssistantTaskManual) error
	appendix             func(context.Context, string, string, string) (model.AssistantTaskAppendix, error)
	appendices           func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskAppendix, error)
	insertAppendix       func(context.Context, model.AssistantTaskAppendix) (bool, error)
	saveAppendix         func(context.Context, model.AssistantTaskAppendix, int64) (bool, error)
	proposal             func(context.Context, string, string, string) (model.AssistantTaskProposal, error)
	proposals            func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error)
	insertProposal       func(context.Context, model.AssistantTaskProposal) (bool, error)
	saveProposal         func(context.Context, model.AssistantTaskProposal, string) (bool, error)
	item                 func(context.Context, string, string, string) (model.AssistantTaskItem, error)
	items                func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskItem, error)
	insertItem           func(context.Context, model.AssistantTaskItem) (bool, error)
	saveItem             func(context.Context, model.AssistantTaskItem, int64) (bool, error)
	transferOpenItems    func(context.Context, string, string, *string) error
	record               func(context.Context, string, string, string) (model.AssistantTaskRecord, error)
	records              func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskRecord, error)
	insertRecord         func(context.Context, model.AssistantTaskRecord) (model.AssistantTaskRecord, error)
	event                func(context.Context, string, string, string) (model.AssistantTaskEvent, error)
	events               func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error)
	insertEvent          func(context.Context, model.AssistantTaskEvent) (bool, error)
	saveEvent            func(context.Context, model.AssistantTaskEvent, string) (bool, error)
	seen                 func(context.Context, string, string, time.Time, []string) error
	inquiry              func(context.Context, string, string, string) (model.AssistantTaskInquiry, error)
	inquiries            func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error)
	insertInquiry        func(context.Context, model.AssistantTaskInquiry) (bool, error)
	saveInquiry          func(context.Context, model.AssistantTaskInquiry, string) (bool, error)
}

func (d *daoStub) Credential(a0 context.Context, a1 model.Principal) error {
	return d.credential(a0, a1)
}

func (d *daoStub) Bot(a0 context.Context, a1 string) (model.Bot, error) { return d.bot(a0, a1) }

func (d *daoStub) Now(a0 context.Context) (time.Time, error) { return d.now(a0) }

func (d *daoStub) LockCreation(a0 context.Context, a1 string) error { return d.lockCreation(a0, a1) }

func (d *daoStub) Task(a0 context.Context, a1 string, a2 string, a3 bool) (model.AssistantTask, error) {
	return d.task(a0, a1, a2, a3)
}

func (d *daoStub) Tasks(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTask, error) {
	return d.tasks(a0, a1)
}

func (d *daoStub) InsertTask(a0 context.Context, a1 model.AssistantTask) (bool, error) {
	return d.insertTask(a0, a1)
}

func (d *daoStub) SaveTask(a0 context.Context, a1 model.AssistantTask, a2 store.AssistantTaskCondition) (bool, error) {
	return d.saveTask(a0, a1, a2)
}

func (d *daoStub) DeleteTaskContent(a0 context.Context, a1 string, a2 string) error {
	return d.deleteTaskContent(a0, a1, a2)
}

func (d *daoStub) ClaimOperation(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskClaimOperation, error) {
	return d.claimOperation(a0, a1, a2, a3)
}

func (d *daoStub) InsertClaimOperation(a0 context.Context, a1 model.AssistantTaskClaimOperation) error {
	return d.insertClaimOperation(a0, a1)
}

func (d *daoStub) Manual(a0 context.Context, a1 string, a2 string, a3 int64) (model.AssistantTaskManual, error) {
	return d.manual(a0, a1, a2, a3)
}

func (d *daoStub) Manuals(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskManual, error) {
	return d.manuals(a0, a1)
}

func (d *daoStub) InsertManual(a0 context.Context, a1 model.AssistantTaskManual) error {
	return d.insertManual(a0, a1)
}

func (d *daoStub) Appendix(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskAppendix, error) {
	return d.appendix(a0, a1, a2, a3)
}

func (d *daoStub) Appendices(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskAppendix, error) {
	return d.appendices(a0, a1)
}

func (d *daoStub) InsertAppendix(a0 context.Context, a1 model.AssistantTaskAppendix) (bool, error) {
	return d.insertAppendix(a0, a1)
}

func (d *daoStub) SaveAppendix(a0 context.Context, a1 model.AssistantTaskAppendix, a2 int64) (bool, error) {
	return d.saveAppendix(a0, a1, a2)
}

func (d *daoStub) Proposal(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskProposal, error) {
	return d.proposal(a0, a1, a2, a3)
}

func (d *daoStub) Proposals(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
	return d.proposals(a0, a1)
}

func (d *daoStub) InsertProposal(a0 context.Context, a1 model.AssistantTaskProposal) (bool, error) {
	return d.insertProposal(a0, a1)
}

func (d *daoStub) SaveProposal(a0 context.Context, a1 model.AssistantTaskProposal, a2 string) (bool, error) {
	return d.saveProposal(a0, a1, a2)
}

func (d *daoStub) Item(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskItem, error) {
	return d.item(a0, a1, a2, a3)
}

func (d *daoStub) Items(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskItem, error) {
	return d.items(a0, a1)
}

func (d *daoStub) InsertItem(a0 context.Context, a1 model.AssistantTaskItem) (bool, error) {
	return d.insertItem(a0, a1)
}

func (d *daoStub) SaveItem(a0 context.Context, a1 model.AssistantTaskItem, a2 int64) (bool, error) {
	return d.saveItem(a0, a1, a2)
}

func (d *daoStub) TransferOpenItems(a0 context.Context, a1 string, a2 string, a3 *string) error {
	return d.transferOpenItems(a0, a1, a2, a3)
}

func (d *daoStub) Record(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskRecord, error) {
	return d.record(a0, a1, a2, a3)
}

func (d *daoStub) Records(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskRecord, error) {
	return d.records(a0, a1)
}

func (d *daoStub) InsertRecord(a0 context.Context, a1 model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
	return d.insertRecord(a0, a1)
}

func (d *daoStub) Event(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskEvent, error) {
	return d.event(a0, a1, a2, a3)
}

func (d *daoStub) Events(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
	return d.events(a0, a1)
}

func (d *daoStub) InsertEvent(a0 context.Context, a1 model.AssistantTaskEvent) (bool, error) {
	return d.insertEvent(a0, a1)
}

func (d *daoStub) SaveEvent(a0 context.Context, a1 model.AssistantTaskEvent, a2 string) (bool, error) {
	return d.saveEvent(a0, a1, a2)
}

func (d *daoStub) MarkAttentionSeen(a0 context.Context, a1 string, a2 string, a3 time.Time, a4 []string) error {
	return d.seen(a0, a1, a2, a3, a4)
}

func (d *daoStub) Inquiry(a0 context.Context, a1 string, a2 string, a3 string) (model.AssistantTaskInquiry, error) {
	return d.inquiry(a0, a1, a2, a3)
}

func (d *daoStub) Inquiries(a0 context.Context, a1 store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
	return d.inquiries(a0, a1)
}

func (d *daoStub) InsertInquiry(a0 context.Context, a1 model.AssistantTaskInquiry) (bool, error) {
	return d.insertInquiry(a0, a1)
}

func (d *daoStub) SaveInquiry(a0 context.Context, a1 model.AssistantTaskInquiry, a2 string) (bool, error) {
	return d.saveInquiry(a0, a1, a2)
}
func baseDAO(t *testing.T, task model.AssistantTask) *daoStub {
	t.Helper()
	d := &daoStub{}
	d.credential = func(ctx context.Context, p model.Principal) error {
		if p != userActor().Principal {
			t.Fatalf("wrong principal: %#v", p)
		}
		return ctx.Err()
	}
	d.bot = func(ctx context.Context, id string) (model.Bot, error) {
		if id != botID && id != targetID {
			t.Fatalf("unexpected Bot %s", id)
		}
		return model.Bot{ID: id, OwnerUserID: ownerID}, ctx.Err()
	}
	d.now = func(ctx context.Context) (time.Time, error) { return epoch, ctx.Err() }
	d.task = func(ctx context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		if owner != ownerID || id != taskID {
			t.Fatalf("wrong task scope %s %s", owner, id)
		}
		return task, ctx.Err()
	}
	return d
}
