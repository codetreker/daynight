//go:build stress

package webhook

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestCaptureCompleteAudienceBeyondFormerLimitsStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	var audience []store.WebhookAudience
	sequence := 0
	for endpoint := 0; endpoint < 257; endpoint++ {
		matches := 1
		if endpoint == 0 {
			matches = 51
		}
		for range matches {
			sequence++
			a := captureAudience(t, protocol.Created)
			a.Endpoint.ID = fmt.Sprintf("%08x-0000-4000-8000-000000000000", endpoint+1)
			a.SubscriptionID = fmt.Sprintf("%08x-1111-4111-8111-000000000000", sequence)
			a.BindingID = fmt.Sprintf("%08x-2222-4222-8222-000000000000", sequence)
			audience = append(audience, a)
		}
	}
	dao := captureSuccessfulDAO(t, audience, 1)
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 1 {
		t.Fatalf("audience writes=%d", len(dao.writes))
	}
	if len(dao.writes[0].deliveries) != 257 {
		t.Fatalf("audience deliveries=%d", len(dao.writes[0].deliveries))
	}
	event := dao.writes[0].event
	offset, total, largest := 0, 0, 0
	seen := map[string]bool{event.ID: true}
	for _, delivery := range dao.writes[0].deliveries {
		count := len(delivery.Matches)
		if count == 0 || offset+count > len(audience) || seen[delivery.ID] {
			t.Fatal("missing/duplicate responsibility or match")
		}
		seen[delivery.ID] = true
		expected := make([][5]string, count)
		for i, a := range audience[offset : offset+count] {
			expected[i] = [5]string{a.SubscriptionID, a.BindingID, a.ProjectID, a.EventType, fmt.Sprint(a.AuthorizationEpoch)}
			m := delivery.Matches[i]
			if m.SubscriptionID != a.SubscriptionID || m.BindingID != a.BindingID || m.ProjectID != a.ProjectID || m.EventType != a.EventType || m.AuthorizationEpoch != a.AuthorizationEpoch || delivery.EndpointID != a.Endpoint.ID {
				t.Fatal("audience tuple lost")
			}
		}
		raw, err := json.Marshal(expected)
		if err != nil {
			t.Fatal(err)
		}
		digest, bodyDigest := sha256.Sum256(raw), sha256.Sum256(event.FactBytes)
		if !bytes.Equal(delivery.OriginalMatchSHA256, digest[:]) || !bytes.Equal(delivery.Body, event.FactBytes) || !bytes.Equal(delivery.BodySHA256, bodyDigest[:]) {
			t.Fatal("complete proof/body/hash lost")
		}
		offset, total, largest = offset+count, total+count, max(largest, count)
	}
	if offset != len(audience) || total != 307 || largest != 51 {
		t.Fatalf("matches=%d consumed=%d largest=%d", total, offset, largest)
	}
}
