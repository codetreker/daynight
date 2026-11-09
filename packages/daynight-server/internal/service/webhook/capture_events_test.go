package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestCaptureGroupsPersonalAndTeamResponsibilities(t *testing.T) {
	personal := captureAudience(t, protocol.Created)
	second := personal
	second.SubscriptionID, second.BindingID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	team := captureAudience(t, protocol.Created)
	team.Endpoint.ID, team.Endpoint.Owner = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", wm.Owner{Kind: "team", ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"}
	team.SubscriptionID, team.BindingID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://team.example/notify"}}`)
	team.Endpoint.DestinationConfiguration, team.Endpoint.Origin, team.Endpoint.DestinationRevision = configuration, "https://team.example", 9
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{personal, second, team}, 1)
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 2 {
		t.Fatalf("responsibilities = %+v", dao.writes)
	}
	one, two := dao.writes[0].deliveries[0], dao.writes[0].deliveries[1]
	if one.EndpointID != personal.Endpoint.ID || one.Owner != personal.Endpoint.Owner || len(one.Matches) != 2 || two.EndpointID != team.Endpoint.ID || two.Owner != team.Endpoint.Owner || len(two.Matches) != 1 || one.ID == two.ID {
		t.Fatal("owner grouping or independent responsibility identity lost")
	}
	if !bytes.Equal(one.DestinationConfiguration, personal.Endpoint.DestinationConfiguration) || !bytes.Equal(two.DestinationConfiguration, configuration) || two.DestinationOrigin != "https://team.example" || two.DestinationRevision != 9 || !bytes.Equal(one.Body, two.Body) {
		t.Fatal("owner-specific targets or shared original event bytes lost")
	}
}

func TestCaptureOriginalProofDoesNotAliasLaterAudienceSnapshots(t *testing.T) {
	first := captureAudience(t, protocol.Created)
	next := captureAudience(t, protocol.Created)
	next.AuthorizationEpoch, next.Endpoint.DestinationRevision = 3, 8
	next.BindingID = "88888888-8888-4888-8888-888888888888"
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/changed"}}`)
	next.Endpoint.DestinationConfiguration = configuration
	dao := captureSuccessfulDAO(t, nil, 1)
	dao.want = append(dao.want, "freeze", "policy", "recorded", "save")
	freezes := 0
	dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) {
		freezes++
		if freezes == 1 {
			return []store.WebhookAudience{first}, nil
		}
		return []store.WebhookAudience{next}, nil
	}
	c := &Capturer{Random: &captureEntropy{}}
	fact := captureFact(protocol.Created)
	if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
		t.Fatalf("initial writes = %+v", dao.writes)
	}
	original := dao.writes[0].deliveries[0]
	oldBody, oldHash, oldTarget := bytes.Clone(original.Body), bytes.Clone(original.OriginalMatchSHA256), bytes.Clone(original.DestinationConfiguration)
	first.Endpoint.DestinationConfiguration[0] ^= 1
	fact.TaskVersion++
	fact.OccurredAt = fact.OccurredAt.Add(time.Second)
	if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 2 || len(dao.writes[1].deliveries) != 1 {
		t.Fatalf("next writes = %+v", dao.writes)
	}
	newer := dao.writes[1].deliveries[0]
	if original.Matches[0].BindingID != captureBindingID || original.Matches[0].AuthorizationEpoch != 2 || original.DestinationRevision != 7 || !bytes.Equal(original.Body, oldBody) || !bytes.Equal(original.OriginalMatchSHA256, oldHash) || !bytes.Equal(original.DestinationConfiguration, oldTarget) {
		t.Fatal("later source/configuration mutated original responsibility")
	}
	if newer.Matches[0].BindingID != next.BindingID || newer.Matches[0].AuthorizationEpoch != 3 || newer.DestinationRevision != 8 || !bytes.Equal(newer.DestinationConfiguration, configuration) || bytes.Equal(newer.OriginalMatchSHA256, oldHash) {
		t.Fatal("next capture did not use its independent audience snapshot")
	}
}

func TestCaptureStepLogicalActionAndFinalVersion(t *testing.T) {
	from, to := int64(1), int64(0)
	for i, tc := range []struct {
		action    string
		configure func(*protocol.Fact)
		want      map[string]any
	}{
		{"created", func(*protocol.Fact) {}, map[string]any{"action": "created"}},
		{"updated", func(f *protocol.Fact) { f.ChangedFields = []string{"title"} }, map[string]any{"action": "updated"}},
		{"status_changed", func(f *protocol.Fact) {
			f.PreviousStatus, f.Status = "todo", "done"
			f.ChangedFields = []string{"description", "title"}
		}, map[string]any{"action": "status_changed", "previousStatus": "todo", "status": "done"}},
		{"moved", func(f *protocol.Fact) { f.FromPosition, f.ToPosition = &from, &to }, map[string]any{"action": "moved", "fromPosition": "1", "toPosition": "0"}},
		{"deleted", func(*protocol.Fact) {}, map[string]any{"action": "deleted"}},
	} {
		t.Run(tc.action, func(t *testing.T) {
			fact := captureFact(protocol.StepUpdated)
			fact.StepID, fact.Action, fact.TaskVersion = "00000002", tc.action, int64(20+i)
			tc.configure(&fact)
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.StepUpdated)}, 1)
			if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
				t.Fatal(err)
			}
			event := dao.writes[0].event
			var wire struct{ Data map[string]any }
			if err := json.Unmarshal(event.FactBytes, &wire); err != nil {
				t.Fatal(err)
			}
			if event.TaskVersion == nil || *event.TaskVersion != fact.TaskVersion || event.StepID == nil || *event.StepID != 2 || wire.Data["taskVersion"] != fmt.Sprint(fact.TaskVersion) || wire.Data["stepId"] != "00000002" {
				t.Fatal("final revision/step anchor lost")
			}
			for key, want := range tc.want {
				if wire.Data[key] != want {
					t.Fatalf("%s = %v, want %v", key, wire.Data[key], want)
				}
			}
			fields, ok := wire.Data["changedFields"].([]any)
			if !ok || len(fields) != len(fact.ChangedFields) {
				t.Fatalf("changed fields = %v", wire.Data["changedFields"])
			}
			for i, want := range fact.ChangedFields {
				if fields[i] != want {
					t.Fatalf("changed field %d = %v", i, fields[i])
				}
			}
			if !slices.Equal(dao.types, []string{protocol.StepUpdated}) {
				t.Fatal("wrong freeze event type")
			}
		})
	}
}
