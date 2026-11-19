package assistanttask

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const (
	inOwner   = "11111111-1111-4111-8111-111111111111"
	inTask    = "22222222-2222-4222-8222-222222222222"
	inBot     = "44444444-4444-4444-8444-444444444444"
	inInbox   = "77777777-7777-4777-8777-777777777777"
	inProject = "88888888-8888-4888-8888-888888888888"
	inSubject = "66666666-6666-4666-8666-666666666666"
	inEvent   = "99999999-9999-4999-8999-999999999999"
	inNewID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	inOrigin  = "https://daynight.example"
)

var inEpoch = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
var inFailure = errors.New("controlled inbound failure")

type inboundDAO struct {
	store.AssistantTaskDAO
	t                                                     *testing.T
	identity, locked                                      model.AssistantTaskInbox
	task                                                  model.AssistantTask
	receipt                                               *model.AssistantTaskInboxReceipt
	pending                                               int
	receiptRejected                                       bool
	fail                                                  string
	calls                                                 []string
	events                                                []model.AssistantTaskEvent
	receipts                                              []model.AssistantTaskInboxReceipt
	reclaimedReceipts, reclaimedEvents                    int
	reclaimBefore                                         time.Time
	taskLocked                                            bool
	identityMissing, taskMissing, lockMissing             bool
	sources                                               *inboundSources
	projectErr                                            error
	projectPrincipal                                      model.Principal
	projectID                                             string
	destinationOwner, destinationOrigin, destinationEvent string
}

func (d *inboundDAO) step(name string) error {
	d.calls = append(d.calls, name)
	if d.fail == name {
		return inFailure
	}
	return nil
}

func (d *inboundDAO) InboxIdentity(_ context.Context, id string) (model.AssistantTaskInbox, error) {
	if err := d.step("identity"); err != nil {
		return model.AssistantTaskInbox{}, err
	}
	if d.identityMissing || id != d.identity.InboxID {
		return model.AssistantTaskInbox{}, model.ErrNotFound
	}
	return d.identity, nil
}

func (d *inboundDAO) Task(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
	if err := d.step("task"); err != nil {
		return model.AssistantTask{}, err
	}
	if owner != inOwner || id != inTask || !lock {
		d.t.Fatalf("task read %s %s %v", owner, id, lock)
	}
	d.taskLocked = true
	if d.taskMissing {
		return model.AssistantTask{}, model.ErrNotFound
	}
	return d.task, nil
}

func (d *inboundDAO) LockInbox(_ context.Context, owner, task, inbox string) (model.AssistantTaskInbox, error) {
	if err := d.step("lock"); err != nil {
		return model.AssistantTaskInbox{}, err
	}
	if !d.taskLocked || owner != inOwner || task != inTask || inbox != inInbox {
		d.t.Fatalf("inbox lock out of order or scope: %v %s %s %s", d.taskLocked, owner, task, inbox)
	}
	if d.lockMissing {
		return model.AssistantTaskInbox{}, model.ErrNotFound
	}
	return d.locked, nil
}

func (d *inboundDAO) Now(context.Context) (time.Time, error) { return inEpoch, d.step("now") }

func (d *inboundDAO) InboxReceipt(_ context.Context, owner, inbox, key string) (model.AssistantTaskInboxReceipt, error) {
	if err := d.step("receipt"); err != nil {
		return model.AssistantTaskInboxReceipt{}, err
	}
	if d.receipt == nil || owner != inOwner || inbox != inInbox || key != d.receipt.IdempotencyKey {
		return model.AssistantTaskInboxReceipt{}, model.ErrNotFound
	}
	return *d.receipt, nil
}

func (d *inboundDAO) PendingInboundEvents(_ context.Context, owner, task, bot string, limit int) (int, error) {
	if owner != inOwner || task != inTask || bot != inBot || limit != core.InboundBacklogLimit {
		d.t.Fatalf("pending scope %s %s %s %d", owner, task, bot, limit)
	}
	return d.pending, d.step("pending")
}

func (d *inboundDAO) InsertEvent(_ context.Context, event model.AssistantTaskEvent) (bool, error) {
	if err := d.step("event"); err != nil {
		return false, err
	}
	d.events = append(d.events, event)
	return true, nil
}

func (d *inboundDAO) InsertInboxReceipt(_ context.Context, receipt model.AssistantTaskInboxReceipt) (bool, error) {
	if err := d.step("insert-receipt"); err != nil {
		return false, err
	}
	d.receipts = append(d.receipts, receipt)
	return !d.receiptRejected, nil
}

func (d *inboundDAO) ReclaimInboxReceipts(_ context.Context, owner, task string, limit int) (int64, error) {
	if owner != inOwner || task != inTask || limit != core.InboundReclaimLimit {
		d.t.Fatalf("receipt reclamation scope %s %s %d", owner, task, limit)
	}
	d.reclaimedReceipts++
	return 0, d.step("reclaim-receipts")
}

func (d *inboundDAO) ReclaimInboundEvents(_ context.Context, owner, task string, before time.Time, limit int) (int64, error) {
	if owner != inOwner || task != inTask || limit != core.InboundReclaimLimit {
		d.t.Fatalf("event reclamation scope %s %s %d", owner, task, limit)
	}
	d.reclaimedEvents++
	d.reclaimBefore = before
	return 0, d.step("reclaim-events")
}

type inboundSources struct {
	dao          *inboundDAO
	provenance   store.WebhookCapturedEventProvenance
	missing      bool
	destinations [][]byte
	pages        []string
}

func (s *inboundSources) CapturedEventProvenance(_ context.Context, id string) (store.WebhookCapturedEventProvenance, error) {
	if err := s.dao.step("provenance"); err != nil {
		return store.WebhookCapturedEventProvenance{}, err
	}
	if s.missing || id != inEvent {
		return store.WebhookCapturedEventProvenance{}, store.ErrWebhookCapturedEventMissing
	}
	return s.provenance, nil
}

// PersonalDeliveryDestinations pages s.destinations; the delivery ID of each
// is its decimal index, zero-padded so IDs order like their positions.
func (s *inboundSources) PersonalDeliveryDestinations(_ context.Context, event, owner, origin, after string, limit int) ([]store.WebhookDeliveryDestination, error) {
	if err := s.dao.step("destinations"); err != nil {
		return nil, err
	}
	if limit != inboxDeliveryScan {
		s.dao.t.Fatalf("destination limit %d", limit)
	}
	s.dao.destinationEvent, s.dao.destinationOwner, s.dao.destinationOrigin = event, owner, origin
	s.pages = append(s.pages, after)
	var page []store.WebhookDeliveryDestination
	for i, configuration := range s.destinations {
		id := fmt.Sprintf("%08d", i)
		if id > after && len(page) < limit {
			page = append(page, store.WebhookDeliveryDestination{DeliveryID: id, Configuration: configuration})
		}
	}
	return page, nil
}

func (d *inboundDAO) ProjectAccess(_ context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	if err := d.step("project"); err != nil {
		return model.ProjectAccess{}, err
	}
	d.projectPrincipal, d.projectID = p, project
	return model.ProjectAccess{ProjectID: project, UserID: p.UserID}, d.projectErr
}

type inboundScope struct{ d *inboundDAO }

func (s inboundScope) AssistantTaskDAO() store.AssistantTaskDAO { return s.d }
func (s inboundScope) WebhookInboundSources() store.WebhookInboundSourceReader {
	return s.d.sources
}
func (s inboundScope) ProjectAccessReader() store.ProjectAccessReader { return s.d }

type inboundWriter struct {
	d       *inboundDAO
	outcome store.TransactionOutcome
	err     error
	runs    int
}

func (w *inboundWriter) WriteAssistantTaskInbound(_ context.Context, call func(store.AssistantTaskInboundScope) error) (store.Completion, error) {
	w.runs++
	err := call(inboundScope{w.d})
	if w.outcome != "" {
		return store.Completion{Outcome: w.outcome}, w.err
	}
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func inboundEventBody(t *testing.T) []byte {
	t.Helper()
	body, err := protocol.Render(inEvent, protocol.Fact{Type: protocol.Created, ProjectID: inProject, TaskID: inSubject, OccurredAt: inEpoch.Add(-time.Second), TaskVersion: 3, Status: "todo"})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func inboundDestination(url string) []byte {
	return []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"` + url + `"}}`)
}

// newInbound returns a fixture whose inbox is enabled with token, whose task
// is actively held by inBot, and whose Daynight sources verify inboundEventBody.
func newInbound(t *testing.T) (*Inbox, *inboundWriter, *inboundDAO, string) {
	t.Helper()
	token, digest, err := core.NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	inbox := model.AssistantTaskInbox{InboxID: inInbox, OwnerUserID: inOwner, TaskID: inTask, State: model.AssistantTaskInboxEnabled, TokenDigest: &digest, Version: 1, CreatedAt: inEpoch.Add(-time.Hour)}
	lease := inEpoch.Add(time.Minute)
	hash := "claim"
	task := model.AssistantTask{ID: inTask, OwnerUserID: inOwner, State: "active", Version: 3, HolderBotID: ptrString(inBot), ClaimTokenHash: &hash, LeaseUntil: &lease}
	d := &inboundDAO{t: t, identity: inbox, locked: inbox, task: task}
	sum := sha256.Sum256(inboundEventBody(t))
	d.sources = &inboundSources{dao: d, provenance: store.WebhookCapturedEventProvenance{EventID: inEvent, Actor: wm.BotActor(inOwner, inBot), FactSHA256: sum[:]}, destinations: [][]byte{inboundDestination("https://other.example/hook"), inboundDestination(inOrigin + core.InboxPathPrefix + inInbox)}}
	w := &inboundWriter{d: d}
	s := NewInbox(w, inOrigin)
	s.newID = func() string { return inNewID }
	return s, w, d, token
}

func ptrString(v string) *string { return &v }

func requireInboundCode(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func daynightInput(t *testing.T) ReceiveInput {
	return ReceiveInput{InboxID: inInbox, MediaType: protocol.MediaType, WebhookID: inEvent, Body: inboundEventBody(t)}
}

func externalInput(token string) ReceiveInput {
	return ReceiveInput{InboxID: inInbox, Token: &token, MediaType: "application/json", IdempotencyKey: "order-1", Body: []byte(`{"order":1}`)}
}

func TestReceiveExternalWritesEventReceiptAndReclaims(t *testing.T) {
	s, w, d, token := newInbound(t)
	result, err := s.Receive(context.Background(), externalInput(token))
	if err != nil || w.runs != 1 {
		t.Fatal(err, w.runs)
	}
	if result.EventID == nil || *result.EventID != inNewID || result.Classification != core.InboundExternal || result.Duplicate || result.Suppressed {
		t.Fatalf("%+v", result)
	}
	sum := sha256.Sum256([]byte(`{"order":1}`))
	if len(d.events) != 1 || d.events[0].ID != inNewID || d.events[0].TargetBotID != inBot || d.events[0].Type != core.InboundEventType {
		t.Fatalf("%+v", d.events)
	}
	if len(d.receipts) != 1 {
		t.Fatal(d.receipts)
	}
	r := d.receipts[0]
	if r.IdempotencyKey != "order-1" || r.BodySHA256 != hex.EncodeToString(sum[:]) || *r.EventID != inNewID || r.TargetBotID != inBot || r.SubjectTaskID != nil || !r.ExpiresAt.Equal(inEpoch.Add(72*time.Hour)) || !r.ReceivedAt.Equal(inEpoch) {
		t.Fatalf("%+v", r)
	}
	if d.reclaimedReceipts != 1 || d.reclaimedEvents != 1 || !d.reclaimBefore.Equal(inEpoch.Add(-30*24*time.Hour)) {
		t.Fatalf("reclamation %d %d %v", d.reclaimedReceipts, d.reclaimedEvents, d.reclaimBefore)
	}
	want := "identity,task,lock,now,receipt,pending,event,insert-receipt,reclaim-receipts,reclaim-events"
	if got := strings.Join(d.calls, ","); got != want {
		t.Fatalf("calls %s", got)
	}
}

func TestReceiveExternalKeyFromWebhookIDOrNone(t *testing.T) {
	s, _, d, token := newInbound(t)
	in := externalInput(token)
	in.IdempotencyKey, in.WebhookID = "", "hook-1"
	if _, err := s.Receive(context.Background(), in); err != nil || len(d.receipts) != 1 || d.receipts[0].IdempotencyKey != "hook-1" {
		t.Fatal(err, d.receipts)
	}
	s, _, d, token = newInbound(t)
	in = externalInput(token)
	in.IdempotencyKey = ""
	if _, err := s.Receive(context.Background(), in); err != nil || len(d.events) != 1 || len(d.receipts) != 0 {
		t.Fatal(err, d.events, d.receipts)
	}
}

func TestReceiveVerifiedDaynightEventWithoutToken(t *testing.T) {
	s, _, d, _ := newInbound(t)
	result, err := s.Receive(context.Background(), daynightInput(t))
	if err != nil || result.Classification != core.InboundDaynight || result.EventID == nil {
		t.Fatal(err, result)
	}
	if d.destinationEvent != inEvent || d.destinationOwner != inOwner || d.destinationOrigin != inOrigin || d.projectPrincipal.UserID != inOwner || d.projectID != inProject {
		t.Fatalf("verification scope %+v", d)
	}
	r := d.receipts[0]
	if r.IdempotencyKey != inEvent || r.SubjectTaskID == nil || *r.SubjectTaskID != inSubject || !r.ExpiresAt.Equal(inEpoch.Add(8*24*time.Hour)) {
		t.Fatalf("%+v", r)
	}
	var payload struct {
		Classification string `json:"classification"`
		Actor          struct {
			Kind, UserID, BotID string
		} `json:"actor"`
	}
	if err := json.Unmarshal(d.events[0].Payload, &payload); err != nil || payload.Classification != core.InboundDaynight || payload.Actor.Kind != "bot" || payload.Actor.BotID != inBot || payload.Actor.UserID != inOwner {
		t.Fatalf("%s %v", d.events[0].Payload, err)
	}
}

func TestReceiveDaynightActorVariants(t *testing.T) {
	for _, actor := range []wm.Actor{{}, wm.UserActor(inOwner), wm.SystemActor()} {
		s, _, d, _ := newInbound(t)
		d.sources.provenance.Actor = actor
		if _, err := s.Receive(context.Background(), daynightInput(t)); err != nil {
			t.Fatal(actor, err)
		}
		var payload struct {
			Actor *struct{ Kind string } `json:"actor"`
		}
		if err := json.Unmarshal(d.events[0].Payload, &payload); err != nil || (payload.Actor == nil) != (actor.Kind == wm.ActorUnknown) || payload.Actor != nil && payload.Actor.Kind != string(actor.Kind) {
			t.Fatalf("%s %v", d.events[0].Payload, err)
		}
	}
}

func TestReceiveUnverifiedDaynightNeedsToken(t *testing.T) {
	for name, change := range map[string]func(*inboundDAO, *ReceiveInput){
		"text media":        func(_ *inboundDAO, in *ReceiveInput) { in.MediaType = "text/plain" },
		"bad media":         func(_ *inboundDAO, in *ReceiveInput) { in.MediaType = "/" },
		"no webhook id":     func(_ *inboundDAO, in *ReceiveInput) { in.WebhookID = "" },
		"forged webhook id": func(_ *inboundDAO, in *ReceiveInput) { in.WebhookID = inNewID },
		"invalid event":     func(_ *inboundDAO, in *ReceiveInput) { in.Body = []byte(`{}`) },
		"missing event":     func(d *inboundDAO, _ *ReceiveInput) { d.sources.missing = true },
		"fact removed": func(d *inboundDAO, _ *ReceiveInput) {
			d.sources.provenance.FactRemovedAt = &inEpoch
		},
		"tampered body": func(d *inboundDAO, _ *ReceiveInput) { d.sources.provenance.FactSHA256 = make([]byte, 32) },
		"other target": func(d *inboundDAO, _ *ReceiveInput) {
			d.sources.destinations = [][]byte{inboundDestination(inOrigin + core.InboxPathPrefix + inNewID)}
		},
		"no delivery":     func(d *inboundDAO, _ *ReceiveInput) { d.sources.destinations = nil },
		"project hidden":  func(d *inboundDAO, _ *ReceiveInput) { d.projectErr = model.ErrNotFound },
		"project deleted": func(d *inboundDAO, _ *ReceiveInput) { d.projectErr = store.ErrProjectDeleted },
	} {
		t.Run(name, func(t *testing.T) {
			s, _, d, token := newInbound(t)
			in := daynightInput(t)
			change(d, &in)
			_, err := s.Receive(context.Background(), in)
			requireInboundCode(t, err, "unauthenticated")
			if len(d.events) != 0 || len(d.receipts) != 0 {
				t.Fatal("rejected request wrote")
			}
			s, _, d, token = newInbound(t)
			in = daynightInput(t)
			in.Token = &token
			change(d, &in)
			result, err := s.Receive(context.Background(), in)
			if in.MediaType == "/" {
				requireInboundCode(t, err, "invalid_input")
				return
			}
			if err != nil || result.Classification != core.InboundExternal {
				t.Fatal(err, result)
			}
		})
	}
}

func TestReceiveVerificationPagesThroughDeliveries(t *testing.T) {
	for _, tc := range []struct {
		name   string
		others int
		pages  []string
	}{
		{"target after first page", inboxDeliveryScan, []string{"", fmt.Sprintf("%08d", inboxDeliveryScan-1)}},
		{"target ends first page", inboxDeliveryScan - 1, []string{""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, d, _ := newInbound(t)
			d.sources.destinations = nil
			for range tc.others {
				d.sources.destinations = append(d.sources.destinations, inboundDestination(inOrigin+core.InboxPathPrefix+inNewID))
			}
			d.sources.destinations = append(d.sources.destinations, inboundDestination(inOrigin+core.InboxPathPrefix+inInbox))
			result, err := s.Receive(context.Background(), daynightInput(t))
			if err != nil || result.Classification != core.InboundDaynight {
				t.Fatal(err, result)
			}
			if !slices.Equal(d.sources.pages, tc.pages) {
				t.Fatalf("pages = %q", d.sources.pages)
			}
		})
	}
	s, _, d, _ := newInbound(t)
	d.sources.destinations = nil
	for range inboxDeliveryScan {
		d.sources.destinations = append(d.sources.destinations, inboundDestination(inOrigin+core.InboxPathPrefix+inNewID))
	}
	_, err := s.Receive(context.Background(), daynightInput(t))
	requireInboundCode(t, err, "unauthenticated")
	if len(d.sources.pages) != 2 {
		t.Fatalf("full untargeted page did not read the next page: %q", d.sources.pages)
	}
}

func TestReceiveVerificationStorageFailuresAbort(t *testing.T) {
	for _, step := range []string{"provenance", "destinations", "project"} {
		s, _, d, _ := newInbound(t)
		d.fail = step
		if _, err := s.Receive(context.Background(), daynightInput(t)); !errors.Is(err, inFailure) || len(d.events) != 0 {
			t.Fatal(step, err)
		}
	}
}

func TestReceiveInboxStateAndTokenRules(t *testing.T) {
	expired := inEpoch.Add(-time.Second)
	for _, tc := range []struct {
		name   string
		change func(*inboundDAO, *ReceiveInput, string)
		code   string
	}{
		{"malformed id", func(_ *inboundDAO, in *ReceiveInput, _ string) { in.InboxID = "x" }, "not_found"},
		{"never existed", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.identityMissing = true }, "not_found"},
		{"tombstone", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.identity.State = model.AssistantTaskInboxTombstone }, "inbox_gone"},
		{"task missing", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.taskMissing = true }, "inbox_gone"},
		{"task deleted", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.task.State = "deleted" }, "inbox_gone"},
		{"task owner changed", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.task.OwnerUserID = inBot }, "inbox_gone"},
		{"disabled while waiting", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.locked.State = model.AssistantTaskInboxTombstone }, "inbox_gone"},
		{"lock missing", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.lockMissing = true }, "inbox_gone"},
		{"malformed token", func(_ *inboundDAO, in *ReceiveInput, _ string) { in.Token = ptrString("dnib_short") }, "invalid_input"},
		{"wrong token", func(_ *inboundDAO, in *ReceiveInput, _ string) {
			other, _, _ := core.NewInboxToken()
			in.Token = &other
		}, "unauthenticated"},
		{"expired overlap", func(d *inboundDAO, in *ReceiveInput, token string) {
			other, digest, _ := core.NewInboxToken()
			d.locked.OverlapTokenDigest, d.locked.TokenDigest, d.locked.OverlapUntil = d.locked.TokenDigest, &digest, &expired
			_ = other
		}, "unauthenticated"},
		{"lease expired", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.task.LeaseUntil = &expired }, "service_unavailable"},
		{"unowned", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.task.HolderBotID, d.task.LeaseUntil = nil, nil }, "service_unavailable"},
		{"header mismatch", func(_ *inboundDAO, in *ReceiveInput, _ string) { in.WebhookID = "other" }, "invalid_input"},
		{"invalid key", func(_ *inboundDAO, in *ReceiveInput, _ string) { in.IdempotencyKey = "has space" }, "invalid_input"},
		{"invalid body", func(_ *inboundDAO, in *ReceiveInput, _ string) { in.Body = []byte("{") }, "invalid_input"},
		{"backlog", func(d *inboundDAO, _ *ReceiveInput, _ string) { d.pending = core.InboundBacklogLimit }, "rate_limited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, d, token := newInbound(t)
			in := externalInput(token)
			tc.change(d, &in, token)
			_, err := s.Receive(context.Background(), in)
			requireInboundCode(t, err, tc.code)
			if len(d.events) != 0 || len(d.receipts) != 0 {
				t.Fatal("rejected request wrote")
			}
		})
	}
}

func TestReceiveAcceptsOverlapTokenAndPendingTransfer(t *testing.T) {
	s, _, d, token := newInbound(t)
	until := inEpoch.Add(time.Hour)
	_, digest, _ := core.NewInboxToken()
	d.locked.OverlapTokenDigest, d.locked.TokenDigest, d.locked.OverlapUntil = d.locked.TokenDigest, &digest, &until
	d.task.ClaimTokenHash = nil
	if result, err := s.Receive(context.Background(), externalInput(token)); err != nil || result.EventID == nil || d.events[0].TargetBotID != inBot {
		t.Fatal(err, result)
	}
}

func TestReceiveIdempotentReplayAndConflict(t *testing.T) {
	s, _, d, token := newInbound(t)
	sum := sha256.Sum256([]byte(`{"order":1}`))
	original := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	d.receipt = &model.AssistantTaskInboxReceipt{InboxID: inInbox, IdempotencyKey: "order-1", BodySHA256: hex.EncodeToString(sum[:]), EventID: &original}
	result, err := s.Receive(context.Background(), externalInput(token))
	if err != nil || !result.Duplicate || result.EventID == nil || *result.EventID != original || len(d.events) != 0 || d.reclaimedReceipts != 0 {
		t.Fatal(err, result)
	}
	in := externalInput(token)
	in.Body = []byte(`{"order":2}`)
	_, err = s.Receive(context.Background(), in)
	requireInboundCode(t, err, "operation_conflict")
	if len(d.events) != 0 {
		t.Fatal("conflict wrote")
	}
}

func TestReceiveStorageFailuresStopBeforeLaterSteps(t *testing.T) {
	for _, step := range []string{"identity", "task", "lock", "now", "receipt", "pending", "event", "insert-receipt", "reclaim-receipts", "reclaim-events"} {
		t.Run(step, func(t *testing.T) {
			s, w, d, token := newInbound(t)
			d.fail = step
			_, err := s.Receive(context.Background(), externalInput(token))
			if !errors.Is(err, inFailure) || d.calls[len(d.calls)-1] != step || w.runs != 1 {
				t.Fatalf("err=%v calls=%v", err, d.calls)
			}
		})
	}
}

func TestReceiveRejectsReceiptRaceUnderTaskLock(t *testing.T) {
	s, _, d, token := newInbound(t)
	d.receiptRejected = true
	if _, err := s.Receive(context.Background(), externalInput(token)); err == nil || !strings.Contains(err.Error(), "under the task lock") {
		t.Fatal(err)
	}
}

func TestReceiveReportsTransactionCompletion(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		err     error
	}{
		{"unknown", store.TransactionUnknown, inFailure},
		{"unknown without cause", store.TransactionUnknown, nil},
		{"committed cleanup failed", store.TransactionCommitted, inFailure},
		{"not committed without cause", store.TransactionNotCommitted, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, w, _, token := newInbound(t)
			w.outcome, w.err = tc.outcome, tc.err
			result, err := s.Receive(context.Background(), externalInput(token))
			var failure *WriteError
			if !errors.As(err, &failure) || failure.Outcome != tc.outcome || failure.Operation != "Receive" || result.EventID != nil {
				t.Fatalf("%v %+v", err, result)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatal("cause lost")
			}
		})
	}
	s, w, d, token := newInbound(t)
	d.fail = "event"
	w.outcome, w.err = store.TransactionNotCommitted, errors.New("rollback")
	if _, err := s.Receive(context.Background(), externalInput(token)); !errors.Is(err, inFailure) {
		t.Fatal("callback failure lost", err)
	}
}
