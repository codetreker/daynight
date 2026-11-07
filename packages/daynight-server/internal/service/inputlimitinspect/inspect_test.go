package inputlimitinspect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerwire "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func input(v string) store.InputLimitsField {
	return store.InputLimitsField{Present: true, Bytes: int64(len(v)), Characters: int64(len([]rune(v))), Value: &v}
}
func testInspector(t *testing.T, stat StatFunc) (*Inspector, *[]Finding) {
	t.Helper()
	var findings []Finding
	i := New(context.Background(), stat, func(store.InputLimitsIdentity) error { return nil }, func(f Finding) error { findings = append(findings, f); return nil })
	if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
		t.Fatal(err)
	}
	return i, &findings
}
func TestPropertyNormalizationNotRawLength(t *testing.T) {
	i, findings := testInspector(t, nil)
	record := store.InputLimitsRecord{Kind: "property", IDs: map[string]string{"taskId": "1"}, Fields: map[string]store.InputLimitsField{"name": input("pullRequests"), "value": input(strings.Repeat(" ", 9000) + "[]")}}
	if err := i.Record(record); err != nil || len(*findings) != 0 {
		t.Fatalf("whitespace candidate: %v, %#v", err, *findings)
	}
	record.Fields["value"] = input(`[{"url":"` + strings.Repeat("<", 1500) + `","title":"x"}]`)
	if err := i.Record(record); err != nil {
		t.Fatal(err)
	}
	if len(*findings) != 1 || (*findings)[0].Category != "violation" || (*findings)[0].Field != "properties.pullRequests" {
		t.Fatalf("escaped value: %#v", *findings)
	}
	record.Fields["value"] = store.InputLimitsField{Present: true, Bytes: 8<<20 + 1}
	if err := i.Record(record); err != nil {
		t.Fatal(err)
	}
	if !i.Outcome().Incomplete || (*findings)[1].Category != "indeterminate" {
		t.Fatalf("withheld value: %#v", *findings)
	}
}
func TestAttachmentStatAndFailure(t *testing.T) {
	cause := errors.New("stat failed")
	expectedPath := "00000000-0000-4000-8000-000000000001/00/00000000-0000-4000-8000-000000000002/f"
	i, findings := testInspector(t, func(_ context.Context, bucket, path string) (int64, error) {
		if bucket != attachment.Bucket || path != expectedPath {
			t.Fatalf("wrong namespace %q %q", bucket, path)
		}
		return 4, nil
	})
	r := store.InputLimitsRecord{Kind: "attachment", IDs: map[string]string{"projectId": "00000000-0000-4000-8000-000000000001", "taskId": "00000000-0000-4000-8000-000000000002"}, Fields: map[string]store.InputLimitsField{"path": input("f"), "contentType": input("text/plain"), "sizeBytes": input("3")}}
	if err := i.Record(r); err != nil || len(*findings) != 1 || (*findings)[0].Diagnostic != "metadata differs from file size" {
		t.Fatalf("stat mismatch %v %#v", err, *findings)
	}
	i.stat = func(context.Context, string, string) (int64, error) { return 0, cause }
	if err := i.Record(r); !errors.Is(err, cause) || !i.Outcome().Incomplete {
		t.Fatalf("stat failure %v", err)
	}
}
func TestStepEscapingBudgetIsIncomplete(t *testing.T) {
	i, findings := testInspector(t, nil)
	r := store.InputLimitsRecord{Kind: "step", IDs: map[string]string{"projectId": "00000000-0000-4000-8000-000000000001", "taskId": "00000000-0000-4000-8000-000000000002", "id": "00000001"}, Fields: map[string]store.InputLimitsField{"version": input("1"), "position": input("0"), "status": input("todo"), "createdAt": input("2026-01-01 00:00:00+00"), "updatedAt": input("2026-01-01 00:00:00+00"), "title": input(strings.Repeat("<", 6<<20)), "description": input("")}}
	if err := i.Record(r); err != nil {
		t.Fatal(err)
	}
	if err := i.Finish(); err != nil {
		t.Fatal(err)
	}
	if !i.Outcome().Incomplete || len(*findings) < 2 || (*findings)[len(*findings)-1].Category != "indeterminate" {
		t.Fatalf("missing bounded-encoding finding %#v", *findings)
	}
}
func TestMaxConfigurationPostgresWhitespace(t *testing.T) {
	args := make([]string, 8)
	for n := range args {
		args[n] = strings.Repeat("a", 4096)
	}
	projects := make([]map[string]any, 128)
	for n := range projects {
		projects[n] = map[string]any{"projectId": fmt.Sprintf("00000000-0000-4000-8000-%012x", n+1), "nativeOverrides": map[string]any{"args": args}}
	}
	document := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 1000, "recoveryLimit": 0, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": projects}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	value, err := worker.ParseWorkerConfiguration(raw)
	if err != nil {
		t.Fatal(err)
	}
	count, err := workerwire.EncodeConfiguration(io.Discard, value, 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	excess := count - worker.MaxConfigurationJSONBytes
	if excess < 0 || excess > 8*4096 {
		t.Fatalf("fixture padding out of range: %d", excess)
	}
	tail := append([]string{}, args...)
	for index := len(tail) - 1; index >= 0 && excess > 0; index-- {
		cut := min(excess, int64(len(tail[index])-1))
		tail[index] = tail[index][:len(tail[index])-int(cut)]
		excess -= cut
	}
	if excess != 0 {
		t.Fatal("fixture cannot fit")
	}
	projects[len(projects)-1]["nativeOverrides"] = map[string]any{"args": tail}
	raw, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	value, err = worker.ParseWorkerConfiguration(raw)
	if err != nil {
		t.Fatal(err)
	}
	count, err = workerwire.EncodeConfiguration(io.Discard, value, worker.MaxConfigurationJSONBytes)
	if err != nil || count != worker.MaxConfigurationJSONBytes {
		t.Fatalf("exact maximum %d: %v", count, err)
	}
	var expanded bytes.Buffer
	if err = json.Indent(&expanded, raw, "", " "); err != nil {
		t.Fatal(err)
	}
	if expanded.Len() > 8<<20 {
		t.Fatalf("fixture exceeds candidate budget: %d", expanded.Len())
	}
	i, findings := testInspector(t, nil)
	r := store.InputLimitsRecord{Kind: "workerConfig", IDs: map[string]string{"workerId": "worker"}, Fields: map[string]store.InputLimitsField{"desired": input(expanded.String()), "observation": {}}}
	if err = i.Record(r); err != nil || len(*findings) != 0 {
		t.Fatalf("maximum normalized configuration: %v %#v", err, *findings)
	}
}

func TestArchiveLimitAndNamespace(t *testing.T) {
	owner := "00000000-0000-4000-8000-000000000001"
	session := "00000000-0000-4000-8000-000000000002"
	object := "projects/" + owner + "/00/" + session + "/" + strings.Repeat("a", 64) + ".json"
	var size int64 = 64 << 20
	i, findings := testInspector(t, func(_ context.Context, bucket, path string) (int64, error) {
		if bucket != "session-archives" || path != object {
			t.Fatalf("archive namespace %s %s", bucket, path)
		}
		return size, nil
	})
	r := store.InputLimitsRecord{Kind: "archive", IDs: map[string]string{"sessionId": session}, Fields: map[string]store.InputLimitsField{"state": input("ready"), "scope": input("task"), "ownerUserId": input(owner), "projectId": input(owner), "objectPath": input(object), "byteLength": input(fmt.Sprint(size))}}
	if err := i.Record(r); err != nil || len(*findings) != 0 {
		t.Fatalf("maximum: %v %#v", err, *findings)
	}
	size++
	r.Fields["byteLength"] = input(fmt.Sprint(size))
	if err := i.Record(r); err != nil || len(*findings) != 2 {
		t.Fatalf("maximum+1: %v %#v", err, *findings)
	}
	r.Fields["objectPath"] = input("wrong/" + strings.Repeat("a", 64) + ".json")
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete {
		t.Fatalf("wrong namespace: %v", err)
	}
}

func TestPendingLoginBlocksClear(t *testing.T) {
	var findings []Finding
	i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(f Finding) error { findings = append(findings, f); return nil })
	observed, _ := parseTime("2026-01-01 00:00:00+00")
	if err := i.Identity(store.InputLimitsIdentity{ObservedAt: observed}); err != nil {
		t.Fatal(err)
	}
	r := store.InputLimitsRecord{Kind: "login", Fields: map[string]store.InputLimitsField{"returnPath": input("/"), "expiresAt": input("2026-01-01 00:00:01+00")}}
	if err := i.Record(r); err != nil || len(findings) != 1 || findings[0].Field != "pendingLogin" {
		t.Fatalf("pending: %v %#v", err, findings)
	}
	r.Fields["expiresAt"] = input("2026-01-01 00:00:00+00")
	if err := i.Record(r); err != nil || len(findings) != 1 {
		t.Fatalf("expired: %v %#v", err, findings)
	}
}

func TestTaskNormalizationBudgetAcrossProperties(t *testing.T) {
	i, findings := testInspector(t, nil)
	tme := "2026-01-01 00:00:00+00"
	r := store.InputLimitsRecord{Kind: "task", CandidateComplete: true, IDs: map[string]string{"id": "00000000-0000-4000-8000-000000000001", "projectId": "00000000-0000-4000-8000-000000000002"}, Numbers: map[string]int64{"dependencies": 0}, Fields: map[string]store.InputLimitsField{"title": input("x"), "description": input(""), "status": input("todo"), "version": input("1"), "createdAt": input(tme), "updatedAt": input(tme), "allowAgents": input("true"), "ready": input("true"), "startedAt": {}, "completedAt": {}, "cancelledAt": {}, "requiredPlatform": {}, "assignedTo": {}}, Properties: map[string]string{"worker": `"` + strings.Repeat("<", 3<<20) + `"`, "pullRequests": `"` + strings.Repeat("<", 3<<20) + `"`}}
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete || len(*findings) != 1 || (*findings)[0].Field != "properties" {
		t.Fatalf("aggregate bound: %v %#v", err, *findings)
	}
}

func TestUploadReservationAndCapacity(t *testing.T) {
	i, findings := testInspector(t, nil)
	r := store.InputLimitsRecord{Kind: "transfer", Fields: map[string]store.InputLimitsField{"state": input("receiving"), "direction": input("upload"), "data": input(`{"nextOffset":5242880}`), "outstandingBytes": input("0"), "chunkBytes": input("5242880")}}
	if err := i.Record(r); err != nil || len(*findings) != 0 {
		t.Fatalf("maximum: %v %#v", err, *findings)
	}
	r.Fields["data"] = input(`{"nextOffset":5242881}`)
	r.Fields["chunkBytes"] = input("5242881")
	if err := i.Record(r); err != nil || len(*findings) != 1 || (*findings)[0].Category != "violation" {
		t.Fatalf("maximum+1: %v %#v", err, *findings)
	}
	r.Fields["data"] = input(`{"nextOffset":5242880}`)
	r.Fields["chunkBytes"] = input("5242880")
	r.Fields["outstandingBytes"] = input("1")
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete || (*findings)[len(*findings)-1].Category != "indeterminate" {
		t.Fatalf("reservation: %v %#v", err, *findings)
	}
}

func TestDownloadSnapshotContentLimit(t *testing.T) {
	object := "00000000-0000-4000-8000-000000000003"
	id := "00000000-0000-4000-8000-000000000001"
	size := int64(5 << 20)
	i, findings := testInspector(t, func(context.Context, string, string) (int64, error) { return size, nil })
	r := store.InputLimitsRecord{Kind: "transfer", IDs: map[string]string{"id": id}, Fields: map[string]store.InputLimitsField{"state": input("ready"), "direction": input("download"), "data": input(fmt.Sprintf(`{"objectId":%q,"totalBytes":%d}`, object, size))}}
	if err := i.Record(r); err != nil || len(*findings) != 0 {
		t.Fatalf("maximum: %v %#v", err, *findings)
	}
	size++
	r.Fields["data"] = input(fmt.Sprintf(`{"objectId":%q,"totalBytes":%d}`, object, size))
	if err := i.Record(r); err != nil || len(*findings) != 2 {
		t.Fatalf("maximum+1: %v %#v", err, *findings)
	}
}

func TestFindingRetainsZeroMeasurements(t *testing.T) {
	raw, err := json.Marshal(Finding{Kind: "login", Field: "pendingLogin", Category: "violation", Actual: 1, Max: 0, Unit: "items"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"max":0`)) {
		t.Fatalf("missing zero maximum: %s", raw)
	}
}
