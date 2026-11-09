package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

func TestCapturePreservesFrozenMatchesAndTargetSnapshot(t *testing.T) {
	first := captureAudience(t, protocol.Created)
	second := first
	second.SubscriptionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	second.BindingID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	audience := []store.WebhookAudience{second, first}
	destination := bytes.Clone(first.Endpoint.DestinationConfiguration)
	dao := captureSuccessfulDAO(t, audience, 1)
	c := &Capturer{Random: &captureEntropy{}}
	if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
		t.Fatalf("writes = %+v", dao.writes)
	}
	write, delivery := dao.writes[0], dao.writes[0].deliveries[0]
	wantMatches := []store.WebhookCapturedMatch{
		{SubscriptionID: second.SubscriptionID, BindingID: second.BindingID, ProjectID: captureProjectID, EventType: protocol.Created, AuthorizationEpoch: 2},
		{SubscriptionID: first.SubscriptionID, BindingID: first.BindingID, ProjectID: captureProjectID, EventType: protocol.Created, AuthorizationEpoch: 2},
	}
	if !slices.Equal(delivery.Matches, wantMatches) || !bytes.Equal(write.event.FactBytes, delivery.Body) {
		t.Fatal("frozen match identities or body changed")
	}
	proofJSON := fmt.Sprintf(`[[%q,%q,%q,%q,"2"],[%q,%q,%q,%q,"2"]]`, first.SubscriptionID, first.BindingID, captureProjectID, protocol.Created, second.SubscriptionID, second.BindingID, captureProjectID, protocol.Created)
	proof := sha256.Sum256([]byte(proofJSON))
	if !bytes.Equal(delivery.OriginalMatchSHA256, proof[:]) {
		t.Fatalf("match digest = %x, want %x", delivery.OriginalMatchSHA256, proof)
	}
	if delivery.DestinationRevision != 7 || !bytes.Equal(delivery.DestinationConfiguration, destination) {
		t.Fatal("target snapshot changed")
	}
	first.Endpoint.DestinationConfiguration[0] ^= 1
	if !bytes.Equal(delivery.DestinationConfiguration, destination) {
		t.Fatal("delivery aliases mutable endpoint configuration")
	}
	if audience[0].SubscriptionID != second.SubscriptionID || audience[1].SubscriptionID != first.SubscriptionID {
		t.Fatal("digest sorting changed frozen audience")
	}
}

func TestCaptureSixFactsAndRecordedMetadata(t *testing.T) {
	for _, kind := range []string{protocol.Created, protocol.StatusChanged, protocol.Paused, protocol.Deleted, protocol.StepUpdated, protocol.ThreadPosted} {
		t.Run(kind, func(t *testing.T) {
			fact := captureFact(kind)
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, kind)}, 1)
			c := &Capturer{Random: &captureEntropy{}}
			if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
				t.Fatal(err)
			}
			if dao.project != captureProjectID || !slices.Equal(dao.types, []string{kind}) || len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
				t.Fatalf("audience request/writes = %+v", dao)
			}
			event, delivery := dao.writes[0].event, dao.writes[0].deliveries[0]
			subject := "tasks/" + captureTaskID
			if kind == protocol.StepUpdated {
				subject += "/steps"
			}
			if kind == protocol.ThreadPosted {
				subject += "/thread/" + fact.MessageID
			}
			if uuid.Validate(event.ID) != nil || uuid.Validate(delivery.ID) != nil || event.ID == delivery.ID || event.EventType != kind || event.Source != "urn:daynight:project:"+captureProjectID || event.Subject != subject || event.ProjectID != captureProjectID || event.TaskID != captureTaskID || !event.OccurredAt.Equal(fact.OccurredAt) || !event.RecordedAt.Equal(captureOccurredAt.Add(time.Minute)) || event.WireVersion != 1 || event.SchemaVersion != 1 || event.FactCodecVersion != 1 {
				t.Fatalf("event metadata = %+v", event)
			}
			if kind == protocol.ThreadPosted {
				if event.TaskVersion != nil || event.MessageID == nil || *event.MessageID != fact.MessageID || event.StepID != nil {
					t.Fatalf("thread anchors = %+v", event)
				}
			} else if event.TaskVersion == nil || *event.TaskVersion != fact.TaskVersion || event.MessageID != nil {
				t.Fatalf("task anchors = %+v", event)
			}
			if kind == protocol.Deleted {
				if event.TaskDeletedAt == nil || !event.TaskDeletedAt.Equal(fact.OccurredAt) {
					t.Fatalf("deleted anchor = %+v", event)
				}
			} else if event.TaskDeletedAt != nil {
				t.Fatal("unrelated deleted anchor")
			}
			if kind == protocol.StepUpdated {
				if event.StepID == nil || *event.StepID != 0xabcdef01 {
					t.Fatalf("step anchor = %+v", event)
				}
			} else if event.StepID != nil {
				t.Fatal("unrelated step anchor")
			}
			if event.OriginRequestID != nil {
				t.Fatal("invented request ID")
			}
			digest := sha256.Sum256(event.FactBytes)
			if !bytes.Equal(event.FactSHA256, digest[:]) || !bytes.Equal(delivery.Body, event.FactBytes) || !bytes.Equal(delivery.BodySHA256, digest[:]) {
				t.Fatal("event/delivery byte or digest mismatch")
			}
			var wire struct {
				ID, Type, Subject string
				Data              map[string]any
			}
			if err := json.Unmarshal(event.FactBytes, &wire); err != nil {
				t.Fatal(err)
			}
			if wire.ID != event.ID || wire.Type != "cc.daynight."+kind+".v1" || wire.Subject != subject || wire.Data["projectId"] != captureProjectID || wire.Data["taskId"] != captureTaskID {
				t.Fatalf("wire identity = %+v", wire)
			}
			switch kind {
			case protocol.Created:
				if wire.Data["taskVersion"] != "42" || wire.Data["status"] != "todo" || wire.Data["paused"] != true {
					t.Fatal(wire.Data)
				}
			case protocol.StatusChanged:
				if wire.Data["previousStatus"] != "todo" || wire.Data["status"] != "in_progress" {
					t.Fatal(wire.Data)
				}
			case protocol.Paused:
				if wire.Data["paused"] != true {
					t.Fatal(wire.Data)
				}
			case protocol.Deleted:
				if wire.Data["deletedAt"] != fact.OccurredAt.Format(time.RFC3339Nano) {
					t.Fatal(wire.Data)
				}
			case protocol.StepUpdated:
				if wire.Data["stepId"] != "abcdef01" || wire.Data["action"] != "created" {
					t.Fatal(wire.Data)
				}
			case protocol.ThreadPosted:
				position, ok := wire.Data["position"].(map[string]any)
				if !ok || position["messageId"] != fact.MessageID || position["createdAt"] != fact.OccurredAt.Format(time.RFC3339Nano) || wire.Data["replyTo"] != *fact.ReplyTo || wire.Data["taskVersion"] != nil {
					t.Fatal(wire.Data)
				}
			}
			assertCaptureResponsibility(t, delivery, fact)
		})
	}
}

func assertCaptureResponsibility(t *testing.T, delivery store.WebhookCapturedDelivery, fact protocol.Fact) {
	t.Helper()
	recorded := captureOccurredAt.Add(time.Minute)
	if delivery.Owner.Kind != "personal" || delivery.Owner.ID != captureOwnerID || delivery.PolicyVersion != 1 || delivery.DestinationRevision != 7 || delivery.DestinationKind != "http" || delivery.AdapterVersion != 1 || delivery.RenderVersion != 1 || delivery.ConfigurationSchemaVersion != 1 || delivery.DestinationOrigin != "https://receiver.example" || delivery.RequestMethod != "POST" || delivery.RequestMediaType != protocol.MediaType || !bytes.Equal(delivery.DeterministicHeadersJSON, []byte("[]")) {
		t.Fatalf("delivery metadata = %+v", delivery)
	}
	if !delivery.AutomaticExpiresAt.Equal(fact.OccurredAt.Add(72*time.Hour)) || !delivery.PayloadExpiresAt.Equal(fact.OccurredAt.Add(7*24*time.Hour)) || !delivery.LastActivityAt.Equal(recorded) || !delivery.MetadataExpiresAt.Equal(recorded.Add(30*24*time.Hour)) {
		t.Fatalf("delivery deadlines = %+v", delivery)
	}
	if len(delivery.AutomaticScheduleAt) != 10 || !delivery.AutomaticScheduleAt[0].Equal(fact.OccurredAt) || !delivery.AutomaticScheduleAt[9].Before(delivery.AutomaticExpiresAt) {
		t.Fatal("automatic schedule bounds")
	}
	policy := captureTestPolicy()
	for i := 1; i < len(delivery.AutomaticScheduleAt); i++ {
		interval := time.Duration(policy.AutomaticOffsetsSeconds[i]-policy.AutomaticOffsetsSeconds[i-1]) * time.Second
		jitter := min(interval/10, 1800*time.Second)
		gap := delivery.AutomaticScheduleAt[i].Sub(delivery.AutomaticScheduleAt[i-1])
		if gap < interval-jitter || gap > interval+jitter {
			t.Fatalf("schedule gap %d = %s", i, gap)
		}
	}
}

func TestCaptureTwoFactsOneFreezeAndProof(t *testing.T) {
	facts := []protocol.Fact{captureFact(protocol.StatusChanged), captureFact(protocol.Paused)}
	audience := []store.WebhookAudience{captureAudience(t, protocol.StatusChanged), captureAudience(t, protocol.Paused)}
	dao := captureSuccessfulDAO(t, audience, 2)
	c := &Capturer{Random: &captureEntropy{}}
	if err := c.CaptureBatch(t.Context(), dao, facts); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(dao.types, []string{protocol.StatusChanged, protocol.Paused}) || len(dao.writes) != 2 {
		t.Fatalf("capture batch = %+v", dao)
	}
	if dao.writes[0].event.ID == dao.writes[1].event.ID {
		t.Fatal("batch reused an event identity")
	}
	for i, w := range dao.writes {
		if w.event.EventType != facts[i].Type || w.event.TaskVersion == nil || *w.event.TaskVersion != 42 || !w.event.OccurredAt.Equal(facts[i].OccurredAt) || len(w.deliveries) != 1 || len(w.deliveries[0].Matches) != 1 || w.deliveries[0].Matches[0].EventType != facts[i].Type {
			t.Fatalf("batch item %d = %+v", i, w)
		}
		delivery := w.deliveries[0]
		bodyDigest := sha256.Sum256(w.event.FactBytes)
		proofJSON := fmt.Sprintf(`[[%q,%q,%q,%q,"2"]]`, captureSubscriptionID, captureBindingID, captureProjectID, facts[i].Type)
		proofDigest := sha256.Sum256([]byte(proofJSON))
		if !bytes.Equal(w.event.FactSHA256, bodyDigest[:]) || !bytes.Equal(delivery.Body, w.event.FactBytes) || !bytes.Equal(delivery.BodySHA256, bodyDigest[:]) || !bytes.Equal(delivery.OriginalMatchSHA256, proofDigest[:]) {
			t.Fatalf("batch item %d bytes or proof changed", i)
		}
		assertCaptureResponsibility(t, w.deliveries[0], facts[i])
	}
}

func TestCaptureBatchOnlyPreparesMatchingFacts(t *testing.T) {
	facts := []protocol.Fact{captureFact(protocol.StatusChanged), captureFact(protocol.Paused)}
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.StatusChanged)}, 1)
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, facts); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || dao.writes[0].event.EventType != protocol.StatusChanged {
		t.Fatalf("unmatched fact saved: %+v", dao.writes)
	}
}

func TestCapturePassesPublishedVectorBytes(t *testing.T) {
	at := time.Date(2026, 11, 6, 8, 0, 0, 0, time.UTC)
	fact := captureFact(protocol.Paused)
	fact.OccurredAt = at
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Paused)}, 1)
	eventID := uuid.MustParse("a0be4d96-fb33-41ba-a7bd-7885c1e94247")
	c := &Capturer{Random: io.MultiReader(bytes.NewReader(eventID[:]), &captureEntropy{})}
	if err := c.CaptureBatch(context.Background(), dao, []protocol.Fact{fact}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
		t.Fatalf("vector writes = %+v", dao.writes)
	}
	want, err := os.ReadFile("../../core/webhook/protocol/testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(want)
	event, delivery := dao.writes[0].event, dao.writes[0].deliveries[0]
	if len(want) != 433 || event.ID != eventID.String() || !bytes.Equal(event.FactBytes, want) || !bytes.Equal(delivery.Body, want) || !bytes.Equal(event.FactSHA256, digest[:]) || !bytes.Equal(delivery.BodySHA256, digest[:]) {
		t.Fatal("prepared vector bytes or digest differ")
	}
}

func TestCaptureDefaultEntropyKeepsIndependentIdentities(t *testing.T) {
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Created)}, 1)
	if err := (&Capturer{}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
		t.Fatalf("capture writes = %+v", dao.writes)
	}
	event, delivery := dao.writes[0].event, dao.writes[0].deliveries[0]
	if uuid.Validate(event.ID) != nil || uuid.Validate(delivery.ID) != nil || event.ID == delivery.ID {
		t.Fatal("default entropy lost responsibility identities")
	}
}

func TestCaptureKeepsFinalInt64Revision(t *testing.T) {
	fact := captureFact(protocol.StatusChanged)
	fact.TaskVersion = math.MaxInt64
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, fact.Type)}, 1)
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 {
		t.Fatalf("capture writes = %+v", dao.writes)
	}
	event := dao.writes[0].event
	var wire struct{ Data map[string]any }
	if err := json.Unmarshal(event.FactBytes, &wire); err != nil {
		t.Fatal(err)
	}
	if event.TaskVersion == nil || *event.TaskVersion != math.MaxInt64 || wire.Data["taskVersion"] != "9223372036854775807" {
		t.Fatal("final source revision lost precision")
	}
}

func TestMatchDigestCanonicalOrderAndRejectedIdentities(t *testing.T) {
	first := store.WebhookCapturedMatch{SubscriptionID: captureSubscriptionID, BindingID: captureBindingID, ProjectID: captureProjectID, EventType: protocol.Created, AuthorizationEpoch: 2}
	second := first
	second.BindingID = "88888888-8888-4888-8888-888888888888"
	third := first
	third.SubscriptionID, third.BindingID, third.AuthorizationEpoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 3
	input := []store.WebhookCapturedMatch{third, second, first}
	before := slices.Clone(input)
	got, err := MatchDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	text := fmt.Sprintf(`[[%q,%q,%q,%q,"2"],[%q,%q,%q,%q,"2"],[%q,%q,%q,%q,"3"]]`, first.SubscriptionID, first.BindingID, captureProjectID, protocol.Created, second.SubscriptionID, second.BindingID, captureProjectID, protocol.Created, third.SubscriptionID, third.BindingID, captureProjectID, protocol.Created)
	want := sha256.Sum256([]byte(text))
	if !bytes.Equal(got, want[:]) || !slices.Equal(input, before) {
		t.Fatal("tuple digest or caller ordering changed")
	}
	first.AuthorizationEpoch = 0
	if _, err := MatchDigest([]store.WebhookCapturedMatch{first}); err == nil {
		t.Fatal("invalid epoch accepted")
	}
	if _, err := MatchDigest([]store.WebhookCapturedMatch{second, second}); err == nil {
		t.Fatal("duplicate original identity accepted")
	}
}
