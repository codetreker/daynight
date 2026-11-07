package taskproperty_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

type prValue struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

func prBudget(t *testing.T, size int) json.RawMessage {
	t.Helper()
	items := []prValue{{URL: strings.Repeat("a", 2048), Title: strings.Repeat("b", 1024)}, {URL: strings.Repeat("a", 2048), Title: strings.Repeat("b", 1024)}, {URL: strings.Repeat("c", 1980)}}
	base, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	items[2].Title = strings.Repeat("d", size-len(base))
	value, err := json.Marshal(items)
	if err != nil || len(value) != size {
		t.Fatalf("fixture: %d %v", len(value), err)
	}
	return value
}

func violation(t *testing.T, err error, field string, actual, max int64) {
	t.Helper()
	var v *limit.Violation
	if !errors.As(err, &v) || v.Field != field || v.Actual != actual || v.Max != max || v.Unit != "bytes" {
		t.Fatalf("unexpected violation: %#v %v", v, err)
	}
}

func TestPropertyValueBudgetAndCanonicalization(t *testing.T) {
	for _, n := range []int{8192, 8193} {
		value := prBudget(t, n)
		normalized, err := taskproperty.NormalizeValue("pullRequests", value)
		if err != nil {
			t.Fatal(err)
		}
		err = taskproperty.AdmitValue("pullRequests", normalized)
		if n == 8192 && err != nil {
			t.Fatal(err)
		}
		if n == 8193 {
			violation(t, err, "properties.pullRequests", 8193, 8192)
		}
	}
	// Replacing five ASCII bytes with a NUL consumes six canonical JSON bytes.
	var escaped []prValue
	if err := json.Unmarshal(prBudget(t, 8192), &escaped); err != nil {
		t.Fatal(err)
	}
	last := &escaped[len(escaped)-1]
	last.URL = last.URL[:len(last.URL)-5] + "\x00"
	escapedRaw, err := json.Marshal(escaped)
	if err != nil {
		t.Fatal(err)
	}
	violation(t, taskproperty.AdmitValue("pullRequests", escapedRaw), "properties.pullRequests", 8193, 8192)
	props := model.TaskProperties{"pullRequests": prBudget(t, 8192), "paused": json.RawMessage(`false`)}
	if err := taskproperty.Admit(props); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`[{"url":"<x>","title":"é"}]`, ` [ { "title": "\u00e9", "url": "\u003cx\u003e" } ] `} {
		value, err := taskproperty.NormalizeValue("pullRequests", json.RawMessage(raw))
		if err != nil || string(value) != `[{"url":"\u003cx\u003e","title":"é"}]` {
			t.Fatalf("normalized %s %v", value, err)
		}
		if err := taskproperty.AdmitValue("pullRequests", value); err != nil {
			t.Fatal(err)
		}
	}
	if err := taskproperty.AdmitValue("unknown", json.RawMessage(`true`)); err == nil {
		t.Fatal("unknown property accepted")
	}
	if err := taskproperty.AdmitValue("paused", json.RawMessage(`true`)); err != nil {
		t.Fatal(err)
	}
	if err := taskproperty.AdmitValue("paused", json.RawMessage(`false`)); err != nil {
		t.Fatal(err)
	}
	if _, err := properties.Normalize(model.TaskProperties{"worker": json.RawMessage(`{}`)}); err == nil {
		t.Fatal("readonly property accepted")
	}
}

func TestPullRequestFieldBudgets(t *testing.T) {
	for _, tc := range []struct {
		field string
		max   int
	}{{"url", 2048}, {"title", 1024}} {
		for _, extra := range []int{0, 1} {
			item := prValue{}
			value := strings.Repeat("é", tc.max/2) + strings.Repeat("x", extra)
			if tc.field == "url" {
				item.URL = value
			} else {
				item.Title = value
			}
			raw, _ := json.Marshal([]prValue{item})
			err := taskproperty.AdmitValue("pullRequests", raw)
			if extra == 0 && err != nil {
				t.Fatal(err)
			}
			if extra == 1 {
				violation(t, err, "properties.pullRequests[0]."+tc.field, int64(tc.max+1), int64(tc.max))
			}
		}
	}
	if err := taskproperty.AdmitValue("pullRequests", json.RawMessage(`[{"url":"\u0000","title":""}]`)); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerFieldBudgets(t *testing.T) {
	for _, tc := range []struct {
		field string
		max   int
		set   func(*model.WorkerClaim, string)
	}{
		{"machine.name", 256, func(w *model.WorkerClaim, s string) { w.Machine.Name = s }},
		{"nativeSessionId", 256, func(w *model.WorkerClaim, s string) { w.NativeSessionID = &s }},
		{"herdr.session", 128, func(w *model.WorkerClaim, s string) { w.Herdr.Session = s }},
		{"herdr.workspaceId", 128, func(w *model.WorkerClaim, s string) { w.Herdr.WorkspaceID = s }},
		{"herdr.paneId", 128, func(w *model.WorkerClaim, s string) { w.Herdr.PaneID = s }},
	} {
		for _, extra := range []int{0, 1} {
			w := workerFixture()
			tc.set(&w, strings.Repeat("é", tc.max/2)+strings.Repeat("x", extra))
			raw, err := taskproperty.EncodeWorker(&w)
			if err != nil {
				t.Fatal(err)
			}
			err = taskproperty.AdmitValue("worker", raw)
			if extra == 0 && err != nil {
				t.Fatalf("%s: %v", tc.field, err)
			}
			if extra == 1 {
				violation(t, err, "properties.worker."+tc.field, int64(tc.max+1), int64(tc.max))
			}
		}
	}
	w := workerFixture()
	w.Herdr = nil
	w.NativeSessionID = nil
	w.AgentControlMode = model.AgentControlModeWeb
	raw, _ := taskproperty.EncodeWorker(&w)
	if err := taskproperty.AdmitValue("worker", raw); err != nil {
		t.Fatal(err)
	}
}

func TestFixedStartupShapeAdmission(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"9223372036854775807","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"9223372036854775807","observedAt":"2026-11-05T00:00:00.123456789Z","startup":{"state":"unknown","reasonCode":"native_transport_unknown"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	value, err := taskproperty.NormalizeValue("sessionStartup", raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := taskproperty.AdmitValue("sessionStartup", value); err != nil {
		t.Fatal(err)
	}
	if _, err := properties.Normalize(model.TaskProperties{"sessionStartup": raw}); err == nil {
		t.Fatal("readonly startup accepted by public write")
	}
	if _, err := taskproperty.NormalizeValue("sessionStartup", json.RawMessage(`{}`)); err == nil {
		t.Fatal("invalid startup accepted by normalization")
	}
}

func TestNormalizeDoesNotAdmit(t *testing.T) {
	raw := prBudget(t, 8193)
	if _, err := taskproperty.NormalizeValue("pullRequests", raw); err != nil {
		t.Fatalf("normalization changed: %v", err)
	}
	if err := taskproperty.AdmitValue("pullRequests", raw); err == nil {
		t.Fatal(fmt.Sprint("oversize admitted"))
	}
}

// The caller bounds and normalizes raw candidates before this entry point. The
// admission check must reject a large normalized value without copying it.
func TestOversizedNormalizedValueIsRejectedBeforeDecode(t *testing.T) {
	raw := json.RawMessage(`[{"url":"` + strings.Repeat("x", 1<<20) + `","title":""}]`)
	var result error
	allocs := testing.AllocsPerRun(10, func() { result = taskproperty.AdmitValue("pullRequests", raw) })
	violation(t, result, "properties.pullRequests", int64(len(raw)), taskproperty.MaxValueBytes)
	if allocs > 3 {
		t.Fatalf("oversized admission allocated %v times", allocs)
	}
}

func TestAdmitPropertiesReturnsTheIndividualViolation(t *testing.T) {
	oversized := prBudget(t, taskproperty.MaxValueBytes+1)
	values, err := taskproperty.Normalize(model.TaskProperties{
		"paused":       json.RawMessage(`true`),
		"pullRequests": oversized,
	})
	if err != nil {
		t.Fatal(err)
	}
	violation(t, taskproperty.Admit(values), "properties.pullRequests", taskproperty.MaxValueBytes+1, taskproperty.MaxValueBytes)
	if string(values["paused"]) != "true" || string(values["pullRequests"]) != string(oversized) {
		t.Fatal("admission modified a candidate property")
	}
	values["pullRequests"] = prBudget(t, taskproperty.MaxValueBytes)
	if err := taskproperty.Admit(values); err != nil {
		t.Fatalf("individually legal properties were rejected: %v", err)
	}
}
