package monitoring

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func summaryObservation(t *testing.T) Observation {
	t.Helper()
	o, err := ParseObservation([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	at := "9999-12-31T23:59:59.999999999Z"
	project := "ffffffff-ffff-4fff-bfff-ffffffffffff"
	task := "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee"
	claim := "dddddddd-dddd-4ddd-bddd-dddddddddddd"
	o["capturedAt"] = at
	o["capacity"] = map[string]any{"observedAt": at, "quality": "current", "limit": int64(64), "occupied": safeInt, "available": int64(0), "detailCoverage": "complete"}
	scheduler := o["scheduler"].(map[string]any)
	scheduler["lastSuccessfulAt"], scheduler["nextPollAt"] = at, at
	a := o["admission"].(map[string]any)
	a["observedAt"] = at
	reasons := make([]any, 16)
	for i := range reasons {
		reasons[i] = map[string]any{"code": reasonCodes[i%len(reasonCodes)], "scope": map[string]any{"kind": "claim", "projectId": project, "taskId": task, "claimId": claim}, "observedAt": at, "nextAttemptAt": nil}
	}
	a["reasons"] = reasons
	encoded, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	validated, err := ParseObservation(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return validated
}

func TestStoredAndPublicSummaryClosedAndBudgeted(t *testing.T) {
	o := summaryObservation(t)
	raw, err := Summary(o)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := ParseStoredSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Admission.Reasons) != 16 || stored.Admission.ObservedAt != o["admission"].(map[string]any)["observedAt"] {
		t.Fatalf("stored admission: %+v", stored.Admission)
	}
	for i, r := range stored.Admission.Reasons {
		if r.CodeIndex != i%len(reasonCodes) || r.Code != reasonCodes[i%len(reasonCodes)] || r.ProjectID != "ffffffff-ffff-4fff-bfff-ffffffffffff" || r.TaskID != "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee" {
			t.Fatalf("reason %d: %+v", i, r)
		}
	}
	public, err := EncodePublicSummary(stored, reasonCodes[:], "restricted")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParsePublicSummary(public)
	if err != nil || len(parsed.Admission.ReasonCodes) != 13 || parsed.Admission.PermissionProjection != "restricted" {
		t.Fatalf("public: %+v %v", parsed, err)
	}
	if strings.Contains(string(public), "ffffffff") || strings.Contains(string(public), "eeeeeeee") || strings.Contains(string(public), "scopeToken") || strings.Contains(string(public), `"reasons"`) {
		t.Fatalf("private refs in public summary: %s", public)
	}
	items := make([]QueryItem, 100)
	u := uuid.NewString()
	maxTime, err := time.Parse(time.RFC3339Nano, "9999-12-31T23:59:59.999999999Z")
	if err != nil {
		t.Fatal(err)
	}
	for i := range items {
		items[i] = QueryItem{WorkerID: u, State: "available", Revision: &u, ReceivedAt: &maxTime, ExpiresAt: &maxTime, Summary: public}
	}
	wire, err := json.Marshal(QueryResponse{ObservedAt: maxTime, Items: items})
	if err != nil || len(wire)+1 > MaxQuery {
		t.Fatalf("query size %d: %v", len(wire)+1, err)
	}
	if _, err := ParseSummary(raw); err == nil {
		t.Fatal("private summary accepted by public codec")
	}
	if _, err := ParseStoredSummary(public); err == nil {
		t.Fatal("public summary accepted by stored codec")
	}
}

func TestStoredSummaryRejectsInvalidReferences(t *testing.T) {
	raw, err := Summary(summaryObservation(t))
	if err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	admission := frame["admission"].(map[string]any)
	good := admission["reasons"].([]any)
	token := good[0].([]any)[1].(string)
	noncanonical := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	noncanonical = noncanonical[:len(noncanonical)-1] + "B"
	cases := map[string]any{
		"out of range": []any{13, token}, "negative": []any{-1, token}, "fraction": []any{1.5, token},
		"padding": []any{0, token + "="}, "bad alphabet": []any{0, "!!!!!!!!!!!!!!!!!!!!!!"},
		"bad size": []any{0, "YQ"}, "noncanonical bits": []any{0, noncanonical},
		"project reason as worker": []any{3, nil}, "extra tuple field": []any{0, token, 1},
	}
	for name, entry := range cases {
		t.Run(name, func(t *testing.T) {
			admission["reasons"] = []any{entry}
			b, err := json.Marshal(frame)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ParseStoredSummary(b); err == nil {
				t.Fatalf("accepted %s", b)
			}
		})
	}
	admission["reasons"] = append(good, good[0])
	if b, _ := json.Marshal(frame); func() bool { _, err := ParseStoredSummary(b); return err == nil }() {
		t.Fatal("accepted 17 reasons")
	}
	admission["reasons"] = []any{[]any{9, token}}
	admission["coverage"] = "partial"
	if b, _ := json.Marshal(frame); func() bool { _, err := ParseStoredSummary(b); return err == nil }() {
		t.Fatal("accepted no-ready with partial coverage")
	}
}

func TestStoredSummaryWorkerProjectAndClaimScopes(t *testing.T) {
	o := summaryObservation(t)
	a := o["admission"].(map[string]any)
	at := a["observedAt"]
	project := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	task := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	a["reasons"] = []any{
		map[string]any{"code": "cleanup-capacity-blocked", "scope": map[string]any{"kind": "worker"}, "observedAt": at, "nextAttemptAt": nil},
		map[string]any{"code": "project-unavailable", "scope": map[string]any{"kind": "project", "projectId": project}, "observedAt": at, "nextAttemptAt": nil},
		map[string]any{"code": "capacity-full", "scope": map[string]any{"kind": "claim", "projectId": project, "taskId": task, "claimId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}, "observedAt": at, "nextAttemptAt": nil},
	}
	raw, err := Summary(o)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParseStoredSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := []StoredReason{{7, "cleanup-capacity-blocked", "", ""}, {3, "project-unavailable", project, ""}, {6, "capacity-full", project, task}}
	if fmt.Sprint(s.Admission.Reasons) != fmt.Sprint(want) {
		t.Fatalf("references: %+v", s.Admission.Reasons)
	}
	if _, err := EncodePublicSummary(s, []string{"no-ready-tasks"}, "current"); err == nil {
		t.Fatal("accepted code absent from observation")
	}
	if _, err := EncodePublicSummary(s, []string{"capacity-full", "project-unavailable"}, "current"); err == nil {
		t.Fatal("accepted unordered public codes")
	}
}

func TestSummaryCodecsRejectInvalidTextAndCapacity(t *testing.T) {
	private, err := Summary(summaryObservation(t))
	if err != nil {
		t.Fatal(err)
	}
	stored, err := ParseStoredSummary(private)
	if err != nil {
		t.Fatal(err)
	}
	public, err := EncodePublicSummary(stored, reasonCodes[:], "current")
	if err != nil {
		t.Fatal(err)
	}
	for _, codec := range []struct {
		name string
		raw  json.RawMessage
		read func(json.RawMessage) error
	}{
		{"stored", private, func(raw json.RawMessage) error { _, err := ParseStoredSummary(raw); return err }},
		{"public", public, func(raw json.RawMessage) error { _, err := ParsePublicSummary(raw); return err }},
	} {
		t.Run(codec.name, func(t *testing.T) {
			invalidUTF8 := bytes.Replace(codec.raw, []byte(`"running"`), []byte{'"', 0xff, '"'}, 1)
			if bytes.Equal(invalidUTF8, codec.raw) || codec.read(invalidUTF8) == nil {
				t.Fatal("accepted invalid UTF-8")
			}
			badCapacity := bytes.Replace(codec.raw, []byte(`"available":0`), []byte(`"available":1`), 1)
			if bytes.Equal(badCapacity, codec.raw) || codec.read(badCapacity) == nil {
				t.Fatal("accepted a capacity inconsistent with its limit and occupancy")
			}
		})
	}
}

func TestSummaryRejectsUnknownInternalReason(t *testing.T) {
	o := summaryObservation(t)
	reasons := o["admission"].(map[string]any)["reasons"].([]any)
	reasons[0].(map[string]any)["code"] = "unrecognized-reason"
	if _, err := Summary(o); err == nil {
		t.Fatal("accepted an unknown reason while constructing a stored summary")
	}
}
