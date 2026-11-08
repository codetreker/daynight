package worker

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestWorkerEncodingMatchesProduction(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	text := "model<&"
	cpu := model.WorkerCPU{Model: "多<&", LogicalProcessors: 2, UsagePercent: 12.5}
	snap := model.WorkerSnapshot{WorkerID: "w", LastReportedAt: now, Telemetry: model.WorkerTelemetry{Machine: model.WorkerMachine{ID: "i", Name: "x<&"}, WorkingDirectory: "/x", SampledAt: now, CPU: model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: &cpu}, AssistantHost: &model.WorkerAssistantHost{ObservedAt: now, DefaultCwd: "/tmp", Providers: []model.WorkerAssistantProvider{{Model: &text, Args: []string{"<&", "世界"}}}}, RuntimeConfiguration: &model.WorkerRuntimeConfiguration{SchemaVersion: 1, Projects: []model.WorkerRuntimeProject{}}}, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &now, Items: []model.WorkerObservedTask{{Title: "t<&"}}}}
	config := model.WorkerConfiguration{Native: model.WorkerNativeConfiguration{Args: []string{"<&"}}, Projects: []model.WorkerProjectConfiguration{}}
	observation := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`{"a":"<&"}`)}}}, ReportedAt: now}
	cases := []struct {
		name    string
		value   any
		newline bool
		encode  func(io.Writer, int64) (int64, error)
	}{{"telemetry", model.WorkerTelemetryWire(snap.Telemetry), false, func(w io.Writer, n int64) (int64, error) { return EncodeTelemetry(w, snap.Telemetry, n) }}, {"configuration", model.WorkerConfigurationWire(config), false, func(w io.Writer, n int64) (int64, error) { return EncodeConfiguration(w, config, n) }}, {"observation", model.WorkerConfigurationReportedObservationWire(observation), false, func(w io.Writer, n int64) (int64, error) { return EncodeObservation(w, observation, n) }}, {"detail", detailResponseWire(WorkerDetailResponse{ObservedAt: now, Worker: Detail(snap)}), true, func(w io.Writer, n int64) (int64, error) { return EncodeDetail(w, snap, now, n) }}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want, err := json.Marshal(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			if tc.newline {
				want = append(want, '\n')
			}
			var out bytes.Buffer
			n, err := tc.encode(&out, int64(len(want)))
			if err != nil || n != int64(len(want)) || !bytes.Equal(out.Bytes(), want) {
				t.Fatalf("got %s want %s err %v", out.Bytes(), want, err)
			}
			_, err = tc.encode(io.Discard, int64(len(want)-1))
			var v *limit.Violation
			if !errors.As(err, &v) {
				t.Fatalf("missing budget error %v", err)
			}
		})
	}
	// Legal strings can expand past the encoded resource budget through escaping.
	snap.Telemetry.WorkingDirectory = strings.Repeat("<", 4<<20/6+1)
	_, err := EncodeTelemetry(io.Discard, snap.Telemetry, 4<<20)
	var v *limit.Violation
	if !errors.As(err, &v) {
		t.Fatalf("escaped telemetry exceeded budget: %v", err)
	}
}

func TestWorkerProjectionStates(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.FixedZone("x", 3600))
	text := "model"
	n := model.WorkerRuntimeNative{Agent: model.AgentCodex, Model: model.WorkerConfigurationValue{Value: &text, Source: "worker"}}
	snapshot := model.WorkerSnapshot{LastReportedAt: now, Telemetry: model.WorkerTelemetry{SampledAt: now, RuntimeConfiguration: &model.WorkerRuntimeConfiguration{SchemaVersion: 1, Native: &n, Projects: []model.WorkerRuntimeProject{{ProjectID: "p", Native: &n}}}}, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable}}
	response := Detail(snapshot)
	if response.ActiveTaskCount != nil || response.Tasks == nil || response.Telemetry.RuntimeConfiguration.Native.Model.Value != &text || response.LastReportedAt.Location() != time.UTC {
		t.Fatal("projection changed semantics")
	}
	var got bytes.Buffer
	nBytes, err := EncodeDetail(&got, snapshot, now, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(detailResponseWire(WorkerDetailResponse{ObservedAt: now.UTC(), Worker: response}))
	want = append(want, '\n')
	if nBytes != int64(len(want)) || !bytes.Equal(got.Bytes(), want) {
		t.Fatal("detail encoding mismatch")
	}
	if RuntimeConfiguration(nil) != nil {
		t.Fatal("nil configuration")
	}
	snapshot.Telemetry.CPU.Value = &model.WorkerCPU{UsagePercent: math.NaN()}
	if _, err = EncodeTelemetry(io.Discard, snapshot.Telemetry, 1<<20); err == nil {
		t.Fatal("invalid float accepted")
	}
}

func TestWorkerProductionMarshalMatchesOriginal(t *testing.T) {
	now := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	value := "<&世界"
	obs := model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`{"a":"<&"}`), NextAttemptAt: &now}}}, ReportedAt: now}
	telemetry := model.WorkerTelemetry{WorkingDirectory: value, SampledAt: now, AssistantHost: &model.WorkerAssistantHost{ObservedAt: now, Providers: []model.WorkerAssistantProvider{{Model: &value, Args: []string{"<&"}}}}}
	config := model.WorkerConfiguration{Native: model.WorkerNativeConfiguration{Args: []string{value}}, Projects: []model.WorkerProjectConfiguration{{NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage(`"<&"`)}}}}
	detail := WorkerDetailResponse{ObservedAt: now, Worker: Detail(model.WorkerSnapshot{Telemetry: telemetry, LastReportedAt: now, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, Items: []model.WorkerObservedTask{{Title: value}}}})}
	cases := []struct{ actual, old any }{{telemetry, model.WorkerTelemetryWire(telemetry)}, {config, model.WorkerConfigurationWire(config)}, {obs, model.WorkerConfigurationReportedObservationWire(obs)}, {detail, detailResponseWire(detail)}}
	for _, tc := range cases {
		got, err := json.Marshal(tc.actual)
		if err != nil {
			t.Fatal(err)
		}
		want, err := json.Marshal(tc.old)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%T got %s want %s err %v", tc.actual, got, want, err)
		}
	}
	var got bytes.Buffer
	n, err := EncodeItem(&got, model.WorkerSnapshot{Telemetry: telemetry, LastReportedAt: now}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(detailWire(Detail(model.WorkerSnapshot{Telemetry: telemetry, LastReportedAt: now})))
	if n != int64(len(want)) || !bytes.Equal(got.Bytes(), want) {
		t.Fatal("Worker item mismatch")
	}
}

func TestDetailChecksCollectionsBeforeProjection(t *testing.T) {
	// Historical oversized arrays must not first be copied into response DTOs.
	snap := model.WorkerSnapshot{Telemetry: model.WorkerTelemetry{AssistantHost: &model.WorkerAssistantHost{Providers: []model.WorkerAssistantProvider{{Args: []string{strings.Repeat("<", 4096)}}}}}}
	for _, encode := range []func() (int64, error){func() (int64, error) { return EncodeItem(io.Discard, snap, 256) }, func() (int64, error) { return EncodeDetail(io.Discard, snap, time.Now(), 256) }} {
		_, err := encode()
		var v *limit.Violation
		if !errors.As(err, &v) || !v.LowerBound {
			t.Fatalf("provider preflight: %v", err)
		}
	}
	snap.Telemetry.AssistantHost = nil
	snap.Telemetry.RuntimeConfiguration = &model.WorkerRuntimeConfiguration{Projects: []model.WorkerRuntimeProject{{ProjectID: strings.Repeat("x", 4096)}}}
	_, err := EncodeItem(io.Discard, snap, 256)
	var v *limit.Violation
	if !errors.As(err, &v) || !v.LowerBound {
		t.Fatalf("project preflight: %v", err)
	}
}
