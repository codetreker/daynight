package worker

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestStoredHistoricalObservationRestoresOrderAndEvidence(t *testing.T) {
	// These are stored shapes produced before mode writes were retired. Mode's
	// index excludes the archive slot; archive's index includes mode.
	const mode = `{"key":{"kind":"agentControlMode"},"targetRevision":"2","appliedValue":"herdr","state":"error","error":{"code":"unavailable","category":"retryable","phase":"apply","occurredAt":"2026-01-01T00:00:00Z"},"lastFailure":null,"nextAttemptAt":null}`
	const archive = `{"key":{"kind":"archiveSessions"},"targetRevision":"2","appliedValue":false,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}`
	const basic = `{"key":{"kind":"maxConcurrent"},"targetRevision":"2","appliedValue":3,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}`
	cases := []struct {
		name, stored, expected string
	}{
		{"archive first", `{"items":[` + basic + `],"controlModeObservation":{"index":0,"item":` + mode + `},"archiveSessionsObservation":{"index":0,"item":` + archive + `}}`, `[` + archive + `,` + mode + `,` + basic + `]`},
		{"mode first", `{"items":[` + basic + `],"controlModeObservation":{"index":0,"item":` + mode + `},"archiveSessionsObservation":{"index":1,"item":` + archive + `}}`, `[` + mode + `,` + archive + `,` + basic + `]`},
		{"mode last", `{"items":[` + basic + `],"controlModeObservation":{"index":1,"item":` + mode + `},"archiveSessionsObservation":{"index":1,"item":` + archive + `}}`, `[` + basic + `,` + archive + `,` + mode + `]`},
		{"inline history", `{"items":[` + mode + `,` + basic + `]}`, `[` + mode + `,` + basic + `]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var expected []model.WorkerConfigurationItem
			if err := json.Unmarshal([]byte(tc.expected), &expected); err != nil {
				t.Fatal(err)
			}
			got, err := DecodeStoredObservation([]byte(tc.stored))
			if err != nil || got == nil || !reflect.DeepEqual(got.Items, expected) {
				t.Fatalf("historical observation: %+v, %v; want %+v", got, err, expected)
			}
		})
	}
	if got, err := DecodeStoredObservation([]byte(`null`)); err != nil || got != nil {
		t.Fatalf("null observation: %+v %v", got, err)
	}
}

func TestStoredObservationRejectsMalformedModeSlot(t *testing.T) {
	for _, slot := range []string{
		`null`, `false`, `{}`, `{"index":0}`, `{"item":{"key":{"kind":"agentControlMode"}}}`,
		`{"index":null,"item":{"key":{"kind":"agentControlMode"}}}`,
		`{"index":0,"item":null}`, `{"index":0,"item":{"key":{"kind":"maxConcurrent"}}}`,
		`{"index":0,"item":{"key":{"kind":"agentControlMode","projectId":"p"}}}`,
		`{"index":-1,"item":{"key":{"kind":"agentControlMode"}}}`,
		`{"index":1,"item":{"key":{"kind":"agentControlMode"}}}`,
		`{"index":0.5,"item":{"key":{"kind":"agentControlMode"}}}`,
	} {
		if got, err := DecodeStoredObservation([]byte(`{"items":[],"controlModeObservation":` + slot + `}`)); err == nil || got != nil {
			t.Fatalf("accepted malformed slot %s: %+v %v", slot, got, err)
		}
	}
	for _, encoded := range []string{
		`{`,
		`{"items":null,"controlModeObservation":{"index":0,"item":{"key":{"kind":"agentControlMode"}}}}`,
		`{"items":[{"key":{"kind":"agentControlMode"}}],"controlModeObservation":{"index":0,"item":{"key":{"kind":"agentControlMode"}}}}`,
	} {
		if got, err := DecodeStoredObservation([]byte(encoded)); err == nil || got != nil {
			t.Fatalf("accepted malformed observation %s: %+v %v", encoded, got, err)
		}
	}
}

func TestStoredArchiveObservationPreservesOrderAndLegacyProjection(t *testing.T) {
	archive := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, AppliedValue: json.RawMessage(`false`)}
	base := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, AppliedValue: json.RawMessage(`3`)}
	sudo := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "enableSudoCleanup"}, AppliedValue: json.RawMessage(`true`)}
	for _, items := range [][]model.WorkerConfigurationItem{{archive, sudo, base}, {sudo, archive, base}, {sudo, base, archive}} {
		value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: items}}
		var encoded bytes.Buffer
		if _, err := EncodeObservation(&encoded, value, math.MaxInt64); err != nil {
			t.Fatal(err)
		}
		got, err := DecodeStoredObservation(encoded.Bytes())
		if err != nil || !reflect.DeepEqual(got, &value) {
			t.Fatalf("round trip %v: %+v %v", items, got, err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if _, present := fields["controlModeObservation"]; present {
			t.Fatalf("new observation emitted a mode slot: %s", encoded.Bytes())
		}
		delete(fields, "archiveSessionsObservation") // Old decoder ignores the unknown slot.
		legacyJSON, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		legacy, err := DecodeStoredObservation(legacyJSON)
		var expected []model.WorkerConfigurationItem
		for _, item := range items {
			if item.Key.Kind != "archiveSessions" {
				expected = append(expected, item)
			}
		}
		if err != nil || legacy == nil || !reflect.DeepEqual(legacy.Items, expected) {
			t.Fatalf("legacy projection %s: %+v %v", legacyJSON, legacy, err)
		}
	}
	for _, slot := range []string{`null`, `{}`, `{"index":-1,"item":{"key":{"kind":"archiveSessions"}}}`, `{"index":1,"item":{"key":{"kind":"archiveSessions"}}}`, `{"index":0,"item":{"key":{"kind":"archiveSessions","projectId":"p"}}}`, `{"index":0,"item":{"key":{"kind":"agentControlMode"}}}`} {
		if got, err := DecodeStoredObservation([]byte(`{"items":[],"archiveSessionsObservation":` + slot + `}`)); err == nil || got != nil {
			t.Fatalf("accepted malformed slot %s: %+v %v", slot, got, err)
		}
	}
	duplicate := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{archive, archive}}}
	if _, err := EncodeObservation(io.Discard, duplicate, math.MaxInt64); err == nil {
		t.Fatal("encoded duplicate archive evidence")
	}
	if got, err := DecodeStoredObservation([]byte(`{"items":[{"key":{"kind":"archiveSessions"}}],"archiveSessionsObservation":{"index":0,"item":{"key":{"kind":"archiveSessions"}}}}`)); err == nil || got != nil {
		t.Fatalf("accepted duplicate stored archive evidence: %+v %v", got, err)
	}
}

func TestStoredObservationRejectsNewModeEvidence(t *testing.T) {
	value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}}}}}
	var encoded bytes.Buffer
	if _, err := EncodeObservation(&encoded, value, math.MaxInt64); err == nil || encoded.Len() != 0 {
		t.Fatalf("encoded retired mode evidence: %s %v", encoded.Bytes(), err)
	}
}

func TestStoredObservationBudgetIncludesArchiveSlot(t *testing.T) {
	value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, AppliedValue: json.RawMessage(`3`)}, {Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, AppliedValue: json.RawMessage(`false`)}}}, ReportedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	var encoded bytes.Buffer
	n, err := EncodeObservation(&encoded, value, math.MaxInt64)
	if err != nil || n != int64(encoded.Len()) {
		t.Fatalf("storage encoding length: %d %d %v", n, encoded.Len(), err)
	}
	public, err := json.Marshal(value)
	if err != nil || len(public) >= encoded.Len() {
		t.Fatalf("private slot overhead missing: public %d stored %d %v", len(public), encoded.Len(), err)
	}
	if _, err := EncodeObservation(io.Discard, value, n); err != nil {
		t.Fatalf("exact budget refused: %v", err)
	}
	_, err = EncodeObservation(io.Discard, value, n-1)
	var violation *limit.Violation
	if !errors.As(err, &violation) || violation.Field != "worker.configuration.observation" || violation.Max != n-1 {
		t.Fatalf("stored-byte budget not enforced: %v", err)
	}
	value.Items[0].AppliedValue = json.RawMessage(`"` + strings.Repeat("x", 4<<20-len(public)-1) + `"`)
	public, err = json.Marshal(value)
	if err != nil || len(public) != 4<<20 {
		t.Fatalf("invalid boundary fixture: %d %v", len(public), err)
	}
	_, err = EncodeObservation(io.Discard, value, 4<<20)
	if !errors.As(err, &violation) {
		t.Fatalf("inline fits but stored slot exceeds budget: %v", err)
	}
}
