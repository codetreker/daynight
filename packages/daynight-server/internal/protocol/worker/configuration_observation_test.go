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

func TestStoredObservationSeparatesModeFromLegacyItems(t *testing.T) {
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "2", AppliedValue: json.RawMessage(`"web"`), State: "applied"}
	for _, items := range [][]model.WorkerConfigurationItem{{mode}, {{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: "2", AppliedValue: json.RawMessage(`3`), State: "applied"}, mode}} {
		value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "2", Items: items}, ReportedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
		var encoded bytes.Buffer
		if _, err := EncodeObservation(&encoded, value, math.MaxInt64); err != nil {
			t.Fatal(err)
		}
		// The baseline DAO decodes this exact public type and ignores unknown top-level fields.
		var legacy model.WorkerConfigurationReportedObservationWire
		if err := json.Unmarshal(encoded.Bytes(), &legacy); err != nil {
			t.Fatal(err)
		}
		if legacy.Items == nil || len(legacy.Items) != len(items)-1 {
			t.Fatalf("legacy reader received mode or null items: %s", encoded.Bytes())
		}
		for _, item := range legacy.Items {
			if item.Key.Kind == "agentControlMode" {
				t.Fatalf("mode remained in legacy items: %s", encoded.Bytes())
			}
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
		if fields["controlModeObservation"] == nil {
			t.Fatalf("private mode slot missing: %s", encoded.Bytes())
		}
	}
}

func TestStoredObservationRestoresOrderAndCompleteEvidence(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 123000000, time.UTC)
	failure := &model.WorkerConfigurationFailure{Code: "unavailable", Category: "retryable", Phase: "apply", OccurredAt: at}
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "2", AppliedValue: json.RawMessage(`"herdr"`), State: "error", Error: failure, LastFailure: failure, NextAttemptAt: &at}
	legacy := []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, AppliedValue: json.RawMessage(`3`)}, {Key: model.WorkerConfigurationItemKey{Kind: "pollIntervalMs"}, AppliedValue: json.RawMessage(`1000`)}}
	for index := 0; index <= len(legacy); index++ {
		items := append([]model.WorkerConfigurationItem{}, legacy[:index]...)
		items = append(items, mode)
		items = append(items, legacy[index:]...)
		value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "1", DesiredRevision: "2", Items: items}, ReportedAt: at}
		var encoded bytes.Buffer
		if _, err := EncodeObservation(&encoded, value, math.MaxInt64); err != nil {
			t.Fatal(err)
		}
		got, err := DecodeStoredObservation(encoded.Bytes())
		if err != nil || got == nil || !reflect.DeepEqual(*got, value) || !reflect.DeepEqual(value.Items, items) {
			t.Fatalf("index %d changed observation: %+v %v", index, got, err)
		}
		public, err := json.Marshal(got)
		if err != nil || bytes.Contains(public, []byte("controlModeObservation")) {
			t.Fatalf("private storage field leaked: %s %v", public, err)
		}
		// Historical inline rows remain readable until their next replacement.
		inline, err := DecodeStoredObservation(public)
		if err != nil || !reflect.DeepEqual(inline, got) {
			t.Fatalf("historical inline observation changed: %+v %v", inline, err)
		}
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
	mode := model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}}
	value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{mode, mode}}}
	if _, err := EncodeObservation(io.Discard, value, math.MaxInt64); err == nil {
		t.Fatal("encoded duplicate mode evidence")
	}
}

func TestStoredObservationBudgetIncludesPrivateSlot(t *testing.T) {
	value := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, AppliedValue: json.RawMessage(`3`)}, {Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, AppliedValue: json.RawMessage(`"web"`)}}}, ReportedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
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
