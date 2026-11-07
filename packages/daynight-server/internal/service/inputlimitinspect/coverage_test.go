package inputlimitinspect

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func validTaskRecord() store.InputLimitsRecord {
	at := "2026-01-01 00:00:00+00"
	return store.InputLimitsRecord{Kind: "task", CandidateComplete: true, IDs: map[string]string{"id": "00000000-0000-4000-8000-000000000001", "projectId": "00000000-0000-4000-8000-000000000002"}, Numbers: map[string]int64{"dependencies": 0}, Fields: map[string]store.InputLimitsField{"title": input("x"), "description": input("d"), "status": input("todo"), "version": input("1"), "createdAt": input(at), "updatedAt": input(at), "allowAgents": input("true"), "ready": input("true"), "startedAt": {}, "completedAt": {}, "cancelledAt": {}, "requiredPlatform": {}, "assignedTo": {}}, Properties: map[string]string{"paused": "false"}}
}
func validWorkerRecord(t *testing.T) store.InputLimitsRecord {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	v := "v"
	telemetry := model.WorkerTelemetry{Machine: model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000003", Name: "worker"}, Platform: model.PlatformLinux, WorkingDirectory: "/work", SampledAt: now,
		OS: model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: &model.WorkerOS{Type: "linux", Arch: "arm64", Release: "6", Version: "v"}}, CPU: model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: &model.WorkerCPU{Model: "cpu", LogicalProcessors: 1}}, Memory: model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: &model.WorkerMemory{TotalBytes: 1}}, Disk: model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: &model.WorkerDisk{TotalBytes: 1}}, Versions: model.WorkerVersions{Daynight: "v", Herdr: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: &v}, Codex: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}}}
	data, err := json.Marshal(telemetry)
	if err != nil {
		t.Fatal(err)
	}
	return store.InputLimitsRecord{Kind: "worker", IDs: map[string]string{"userId": "00000000-0000-4000-8000-000000000001", "workerId": "00000000-0000-4000-8000-000000000002"}, Fields: map[string]store.InputLimitsField{"telemetry": input(string(data)), "taskSnapshot": input(`{"state":"unavailable","items":[]}`), "createdAt": input("2026-01-01 00:00:00+00"), "lastSeenAt": input("2026-01-01 00:00:00+00")}}
}
func TestRecordPoliciesAndIncompleteRepresentations(t *testing.T) {
	goodProfile := func() store.InputLimitsRecord {
		return store.InputLimitsRecord{Kind: "profile", IDs: map[string]string{"id": "00000000-0000-4000-8000-000000000001"}, Fields: map[string]store.InputLimitsField{"identityId": input("identity"), "email": {}, "emailVerified": {}, "name": {}, "avatarUrl": {}, "personalTeamId": input("00000000-0000-4000-8000-000000000002"), "personalTeamName": {}}}
	}
	tests := []struct {
		name     string
		make     func() store.InputLimitsRecord
		mutate   func(*store.InputLimitsRecord)
		category string
	}{
		{"task-valid", validTaskRecord, nil, ""},
		{"task-text", validTaskRecord, func(r *store.InputLimitsRecord) { r.Fields["title"] = input(strings.Repeat("a", 1025)) }, "violation"},
		{"task-dependencies", validTaskRecord, func(r *store.InputLimitsRecord) { r.Numbers["dependencies"] = 16 }, "violation"},
		{"task-withheld", validTaskRecord, func(r *store.InputLimitsRecord) { r.CandidateComplete = false }, "indeterminate"},
		{"task-bad-time", validTaskRecord, func(r *store.InputLimitsRecord) { r.Fields["createdAt"] = input("invalid") }, "indeterminate"},
		{"task-bad-version", validTaskRecord, func(r *store.InputLimitsRecord) { r.Fields["version"] = input("invalid") }, "indeterminate"},
		{"task-bad-property", validTaskRecord, func(r *store.InputLimitsRecord) { r.Properties["paused"] = "{}" }, "indeterminate"},
		{"task-started", validTaskRecord, func(r *store.InputLimitsRecord) {
			r.Fields["startedAt"] = input("2026-01-01 00:00:00+00")
			r.Fields["requiredPlatform"] = input("linux")
			r.Fields["assignedTo"] = input("00000000-0000-4000-8000-000000000001")
		}, ""},
		{"project-valid", func() store.InputLimitsRecord {
			return store.InputLimitsRecord{Kind: "project", Fields: map[string]store.InputLimitsField{"name": input("project"), "repoUrl": input("repo")}}
		}, nil, ""},
		{"project-limit", func() store.InputLimitsRecord {
			return store.InputLimitsRecord{Kind: "project", Fields: map[string]store.InputLimitsField{"name": input("p"), "repoUrl": input(strings.Repeat("x", 4097))}}
		}, nil, "violation"},
		{"team-limit", func() store.InputLimitsRecord {
			return store.InputLimitsRecord{Kind: "team", Fields: map[string]store.InputLimitsField{"name": input(strings.Repeat("好", 257))}}
		}, nil, "violation"},
		{"profile-valid", goodProfile, nil, ""},
		{"profile-length", goodProfile, func(r *store.InputLimitsRecord) { r.Fields["email"] = input(strings.Repeat("a", 1025)) }, "violation"},
		{"profile-team-missing", goodProfile, func(r *store.InputLimitsRecord) { r.Fields["personalTeamId"] = store.InputLimitsField{} }, "indeterminate"},
		{"profile-verified", goodProfile, func(r *store.InputLimitsRecord) { r.Fields["emailVerified"] = input("true") }, ""},
		{"profile-bad-bool", goodProfile, func(r *store.InputLimitsRecord) { r.Fields["emailVerified"] = input("bad") }, "indeterminate"},
		{"worker-valid", func() store.InputLimitsRecord { return validWorkerRecord(t) }, nil, ""},
		{"worker-missing", func() store.InputLimitsRecord { return validWorkerRecord(t) }, func(r *store.InputLimitsRecord) { r.Fields["telemetry"] = store.InputLimitsField{Present: true} }, "indeterminate"},
		{"worker-invalid", func() store.InputLimitsRecord { return validWorkerRecord(t) }, func(r *store.InputLimitsRecord) { r.Fields["telemetry"] = input(`{}`) }, "indeterminate"},
		{"worker-state", func() store.InputLimitsRecord { return validWorkerRecord(t) }, func(r *store.InputLimitsRecord) { r.Fields["taskSnapshot"] = input(`{"state":"other","items":[]}`) }, "indeterminate"},
		{"worker-limit", func() store.InputLimitsRecord { return validWorkerRecord(t) }, func(r *store.InputLimitsRecord) {
			raw, _ := field(*r, "telemetry")
			var v model.WorkerTelemetry
			json.Unmarshal([]byte(raw), &v)
			v.Machine.Name = strings.Repeat("m", 257)
			data, _ := json.Marshal(v)
			r.Fields["telemetry"] = input(string(data))
		}, "violation"},
		{"worker-config", func() store.InputLimitsRecord {
			return store.InputLimitsRecord{Kind: "workerConfig", Fields: map[string]store.InputLimitsField{"desired": input(`{"maxConcurrent":1,"pollIntervalMs":1000,"recoveryLimit":0,"native":{"agent":"codex","model":null,"args":[]},"projects":[]}`), "observation": input(`{"baseRevision":"0","desiredRevision":"1","items":[],"reportedAt":"2026-01-01T00:00:00Z"}`)}}
		}, nil, ""},
		{"active", func() store.InputLimitsRecord {
			return store.InputLimitsRecord{Kind: "activeOwner", Numbers: map[string]int64{"count": 101}}
		}, nil, "violation"},
		{"unknown", func() store.InputLimitsRecord { return store.InputLimitsRecord{Kind: "unrecognized"} }, nil, "indeterminate"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.make()
			if tc.mutate != nil {
				tc.mutate(&r)
			}
			i, f := testInspector(t, nil)
			if err := i.Record(r); err != nil {
				t.Fatal(err)
			}
			if tc.category == "" && len(*f) > 0 {
				t.Fatalf("unexpected %#v", *f)
			}
			if tc.category != "" {
				found := false
				for _, v := range *f {
					if v.Category == tc.category {
						found = true
					}
				}
				if !found {
					t.Fatalf("expected %s: %#v", tc.category, *f)
				}
			}
		})
	}
}
func TestTransferChunkStatAndFailures(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	obj := "00000000-0000-4000-8000-000000000002"
	calls := 0
	i, findings := testInspector(t, func(_ context.Context, bucket, path string) (int64, error) {
		calls++
		if bucket != "mcp-transfers" || path != "00/"+id+"/"+obj {
			t.Fatalf("wrong address %s/%s", bucket, path)
		}
		return 1, nil
	})
	r := store.InputLimitsRecord{Kind: "transferChunk", IDs: map[string]string{"transferId": id, "objectId": obj}, Fields: map[string]store.InputLimitsField{"state": input("receiving"), "sizeBytes": input("1"), "offset": input("0")}}
	if err := i.Record(r); err != nil || calls != 1 || len(*findings) != 0 {
		t.Fatalf("valid: %v %#v", err, *findings)
	}
	r.Fields["offset"] = input("5242880")
	if err := i.Record(r); err != nil || len(*findings) == 0 || (*findings)[0].Field != "chunkEnd" {
		t.Fatalf("oversized: %v %#v", err, *findings)
	}
	r.Fields["state"] = input("cleanup_pending")
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete {
		t.Fatalf("unresolved: %v", err)
	}
}
func TestVisitorErrorsAndCancellation(t *testing.T) {
	cause := errors.New("sink failed")
	i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(Finding) error { return cause })
	if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
		t.Fatal(err)
	}
	if err := i.Record(store.InputLimitsRecord{Kind: "activeOwner", Numbers: map[string]int64{"count": 101}}); !errors.Is(err, cause) {
		t.Fatalf("sink: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	j := New(ctx, nil, nil, nil)
	if err := j.Record(store.InputLimitsRecord{}); !errors.Is(err, context.Canceled) || !j.Outcome().Incomplete {
		t.Fatalf("cancel: %v", err)
	}
	k := New(context.Background(), nil, nil, nil)
	if err := k.Finish(); err == nil || !k.Outcome().Incomplete {
		t.Fatal("missing identity accepted")
	}
}

func validStepRecord() store.InputLimitsRecord {
	return store.InputLimitsRecord{Kind: "step", IDs: map[string]string{"projectId": "00000000-0000-4000-8000-000000000001", "taskId": "00000000-0000-4000-8000-000000000002", "id": "00000001"}, Fields: map[string]store.InputLimitsField{"version": input("1"), "position": input("0"), "status": input("todo"), "createdAt": input("2026-01-01 00:00:00+00"), "updatedAt": input("2026-01-01 00:00:00+00"), "title": input("step"), "description": input("description")}}
}
func TestStepGroupingAndInvalidStoredValues(t *testing.T) {
	i, findings := testInspector(t, nil)
	r := validStepRecord()
	if err := i.Record(r); err != nil {
		t.Fatal(err)
	}
	r.IDs = copyIDs(r.IDs)
	r.IDs["id"] = "00000002"
	r.Fields["position"] = input("1")
	if err := i.Record(r); err != nil {
		t.Fatal(err)
	}
	if err := i.Finish(); err != nil || len(*findings) != 0 {
		t.Fatalf("valid collection: %v %#v", err, *findings)
	}
	cases := []struct {
		name   string
		change func(*store.InputLimitsRecord)
	}{
		{"missing-parent", func(r *store.InputLimitsRecord) { r.Fields["version"] = store.InputLimitsField{} }},
		{"bad-version", func(r *store.InputLimitsRecord) { r.Fields["version"] = input("bad") }},
		{"withheld", func(r *store.InputLimitsRecord) { r.Fields["description"] = store.InputLimitsField{Present: true} }},
		{"bad-position", func(r *store.InputLimitsRecord) { r.Fields["position"] = input("bad") }},
		{"gap", func(r *store.InputLimitsRecord) { r.Fields["position"] = input("1") }},
		{"bad-created", func(r *store.InputLimitsRecord) { r.Fields["createdAt"] = input("bad") }},
		{"bad-updated", func(r *store.InputLimitsRecord) { r.Fields["updatedAt"] = input("bad") }},
		{"bad-status", func(r *store.InputLimitsRecord) { r.Fields["status"] = input("bad") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			i, f := testInspector(t, nil)
			r := validStepRecord()
			tc.change(&r)
			if err := i.Record(r); err != nil {
				t.Fatal(err)
			}
			if err := i.Finish(); err != nil {
				t.Fatal(err)
			}
			if !i.Outcome().Incomplete || len(*f) == 0 {
				t.Fatalf("invalid step accepted %#v", *f)
			}
		})
	}
}
func TestWorkerStoredFailures(t *testing.T) {
	cases := []struct {
		name   string
		change func(*store.InputLimitsRecord)
	}{
		{"malformed", func(r *store.InputLimitsRecord) { r.Fields["taskSnapshot"] = input("{") }},
		{"bad-created", func(r *store.InputLimitsRecord) { r.Fields["createdAt"] = input("bad") }},
		{"bad-reported", func(r *store.InputLimitsRecord) { r.Fields["lastSeenAt"] = input("bad") }},
		{"unavailable-has-time", func(r *store.InputLimitsRecord) {
			r.Fields["taskSnapshot"] = input(`{"state":"unavailable","observedAt":"2026-01-01T00:00:00Z","items":[]}`)
		}},
		{"observed-missing-time", func(r *store.InputLimitsRecord) { r.Fields["taskSnapshot"] = input(`{"state":"observed","items":[]}`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			i, f := testInspector(t, nil)
			r := validWorkerRecord(t)
			tc.change(&r)
			if err := i.Record(r); err != nil {
				t.Fatal(err)
			}
			if !i.Outcome().Incomplete || len(*f) == 0 {
				t.Fatalf("invalid worker accepted %#v", *f)
			}
		})
	}
	i, f := testInspector(t, nil)
	r := validWorkerRecord(t)
	r.Fields["taskSnapshot"] = input(`{"state":"observed","observedAt":"2026-01-01T00:00:00Z","inventoryObservedAt":"2026-01-01T00:00:00Z","items":[]}`)
	if err := i.Record(r); err != nil || len(*f) != 0 {
		t.Fatalf("observed: %v %#v", err, *f)
	}
}
func TestConfigAndTransferInvalidStates(t *testing.T) {
	cases := []store.InputLimitsRecord{
		{Kind: "workerConfig", Fields: map[string]store.InputLimitsField{"desired": {Present: true}, "observation": {}}},
		{Kind: "workerConfig", Fields: map[string]store.InputLimitsField{"desired": input("{}"), "observation": {}}},
		{Kind: "workerConfig", Fields: map[string]store.InputLimitsField{"desired": {}, "observation": input("{")}},
		{Kind: "transfer", Fields: map[string]store.InputLimitsField{"state": input("receiving"), "direction": input("upload"), "data": input(`{"nextOffset":0}`), "outstandingBytes": input("0"), "chunkBytes": input("1")}},
		{Kind: "transfer", Fields: map[string]store.InputLimitsField{"state": input("ready"), "direction": input("download"), "data": input(`{"objectId":"no-size"}`)}},
		{Kind: "transfer", Fields: map[string]store.InputLimitsField{"state": input("pending"), "direction": input("download")}},
		{Kind: "transferChunk", Fields: map[string]store.InputLimitsField{"state": input("receiving"), "sizeBytes": input("-1"), "offset": input("0")}},
		{Kind: "transferChunk", Fields: map[string]store.InputLimitsField{"state": input("receiving"), "sizeBytes": input("1"), "offset": input("-1")}},
	}
	for n, r := range cases {
		i, f := testInspector(t, nil)
		if err := i.Record(r); err != nil {
			t.Fatalf("case %d: %v", n, err)
		}
		if len(*f) == 0 || (*f)[0].Category != "indeterminate" {
			t.Fatalf("case %d accepted %#v", n, *f)
		}
	}
}
func TestMissingFileAndSinkFailures(t *testing.T) {
	r := store.InputLimitsRecord{Kind: "attachment", IDs: map[string]string{"projectId": "00000000-0000-4000-8000-000000000001", "taskId": "00000000-0000-4000-8000-000000000002"}, Fields: map[string]store.InputLimitsField{"path": input("p"), "contentType": input("text/plain"), "sizeBytes": input("0")}}
	i, f := testInspector(t, nil)
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete || len(*f) == 0 {
		t.Fatalf("missing stat: %v %#v", err, *f)
	}
	i, f = testInspector(t, nil)
	r.Fields["path"] = input("../unsafe")
	if err := i.Record(r); err != nil || !i.Outcome().Incomplete || len(*f) == 0 {
		t.Fatalf("unsafe address: %v %#v", err, *f)
	}
	cause := errors.New("sink failed")
	i = New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(Finding) error { return cause })
	if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
		t.Fatal(err)
	}
	r.Fields["path"] = input(strings.Repeat("a", 1025))
	if err := i.Record(r); !errors.Is(err, cause) {
		t.Fatalf("sink: %v", err)
	}
}

func TestTaskInvalidMetadata(t *testing.T) {
	changes := []func(*store.InputLimitsRecord){
		func(r *store.InputLimitsRecord) { delete(r.Fields, "title") },
		func(r *store.InputLimitsRecord) { r.Fields["updatedAt"] = input("bad") },
		func(r *store.InputLimitsRecord) { r.Fields["allowAgents"] = input("bad") },
		func(r *store.InputLimitsRecord) { r.Fields["ready"] = input("bad") },
		func(r *store.InputLimitsRecord) { r.Fields["startedAt"] = input("bad") },
		func(r *store.InputLimitsRecord) { delete(r.Fields, "requiredPlatform") },
		func(r *store.InputLimitsRecord) { delete(r.Fields, "assignedTo") },
		func(r *store.InputLimitsRecord) { delete(r.Numbers, "dependencies") },
	}
	for n, change := range changes {
		i, f := testInspector(t, nil)
		r := validTaskRecord()
		change(&r)
		if err := i.Record(r); err != nil || len(*f) == 0 {
			t.Fatalf("case %d: %v %#v", n, err, *f)
		}
	}
}
func TestArchiveCorruptMetadataIsNotClear(t *testing.T) {
	base := func() store.InputLimitsRecord {
		return store.InputLimitsRecord{Kind: "archive", IDs: map[string]string{"sessionId": "00000000-0000-4000-8000-000000000002"}, Fields: map[string]store.InputLimitsField{"state": input("ready"), "scope": input("task"), "ownerUserId": input("00000000-0000-4000-8000-000000000003"), "projectId": input("00000000-0000-4000-8000-000000000001"), "objectPath": input("projects/00000000-0000-4000-8000-000000000001/00/00000000-0000-4000-8000-000000000002/" + strings.Repeat("a", 64) + ".json"), "byteLength": input("1")}}
	}
	changes := []func(*store.InputLimitsRecord){
		func(r *store.InputLimitsRecord) { delete(r.Fields, "state") },
		func(r *store.InputLimitsRecord) { delete(r.Fields, "objectPath") },
		func(r *store.InputLimitsRecord) { r.Fields["byteLength"] = input("bad") },
		func(r *store.InputLimitsRecord) { delete(r.Fields, "ownerUserId") },
		func(r *store.InputLimitsRecord) {
			r.Fields["ownerUserId"] = input("invalid")
			r.Fields["projectId"] = store.InputLimitsField{}
			r.Fields["scope"] = input("test")
		},
		func(r *store.InputLimitsRecord) { r.Fields["scope"] = input("test") },
	}
	for n, change := range changes {
		i, f := testInspector(t, nil)
		r := base()
		change(&r)
		if err := i.Record(r); err != nil || len(*f) == 0 {
			t.Fatalf("case %d: %v %#v", n, err, *f)
		}
	}
	i, f := testInspector(t, nil)
	r := base()
	r.Fields["state"] = input("pending")
	if err := i.Record(r); err != nil || len(*f) != 0 {
		t.Fatalf("pending: %v %#v", err, *f)
	}
	i, f = testInspector(t, nil)
	if err := i.Record(base()); err != nil || len(*f) == 0 {
		t.Fatalf("no stat: %v %#v", err, *f)
	}
	cause := errors.New("archive stat failed")
	i, _ = testInspector(t, func(context.Context, string, string) (int64, error) { return 0, cause })
	if err := i.Record(base()); !errors.Is(err, cause) || !i.Outcome().Incomplete {
		t.Fatalf("stat error %v", err)
	}
}
func TestTransferLocatorAndInspectionErrors(t *testing.T) {
	base := func() store.InputLimitsRecord {
		return store.InputLimitsRecord{Kind: "transfer", IDs: map[string]string{"id": "00000000-0000-4000-8000-000000000001"}, Fields: map[string]store.InputLimitsField{"state": input("ready"), "direction": input("download"), "data": input(`{"objectId":"00000000-0000-4000-8000-000000000002","totalBytes":1}`)}}
	}
	i, f := testInspector(t, nil)
	if err := i.Record(base()); err != nil || !i.Outcome().Incomplete || len(*f) == 0 {
		t.Fatalf("no stat: %v %#v", err, *f)
	}
	i, f = testInspector(t, nil)
	r := base()
	r.IDs["id"] = "invalid"
	if err := i.Record(r); err != nil || len(*f) == 0 {
		t.Fatalf("invalid namespace: %v %#v", err, *f)
	}
	i, f = testInspector(t, nil)
	r = base()
	r.Fields["data"] = input(`{"objectId":"bad","totalBytes":1}`)
	if err := i.Record(r); err != nil || len(*f) == 0 {
		t.Fatalf("invalid object: %v %#v", err, *f)
	}
	cause := errors.New("stat failed")
	i, _ = testInspector(t, func(context.Context, string, string) (int64, error) { return 0, cause })
	if err := i.Record(base()); !errors.Is(err, cause) || !i.Outcome().Incomplete {
		t.Fatalf("stat failure: %v", err)
	}
	i, f = testInspector(t, func(context.Context, string, string) (int64, error) { return 2, nil })
	if err := i.Record(base()); err != nil || len(*f) != 1 || (*f)[0].Diagnostic != "metadata differs from file size" {
		t.Fatalf("mismatch: %v %#v", err, *f)
	}
}

func TestOrganizationAndLoginSinkFailure(t *testing.T) {
	cause := errors.New("report sink unavailable")
	cases := []store.InputLimitsRecord{
		{Kind: "project", Fields: map[string]store.InputLimitsField{"name": input(strings.Repeat("x", 257)), "repoUrl": input("repo")}},
		{Kind: "team", Fields: map[string]store.InputLimitsField{"name": input(strings.Repeat("x", 257))}},
		{Kind: "login", Fields: map[string]store.InputLimitsField{"returnPath": input(strings.Repeat("x", 4097)), "expiresAt": input("2026-01-01 00:00:00+00")}},
	}
	for _, record := range cases {
		t.Run(record.Kind, func(t *testing.T) {
			i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(Finding) error { return cause })
			if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
				t.Fatal(err)
			}
			if err := i.Record(record); !errors.Is(err, cause) {
				t.Fatalf("sink error lost: %v", err)
			}
		})
	}
}

func TestLoginMissingOrInvalidExpiry(t *testing.T) {
	for _, expires := range []store.InputLimitsField{{}, input("invalid")} {
		var findings []Finding
		i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(f Finding) error { findings = append(findings, f); return nil })
		if err := i.Identity(store.InputLimitsIdentity{ObservedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}); err != nil {
			t.Fatal(err)
		}
		record := store.InputLimitsRecord{Kind: "login", Fields: map[string]store.InputLimitsField{"returnPath": input("/"), "expiresAt": expires}}
		if err := i.Record(record); err != nil || len(findings) != 1 || findings[0].Category != "indeterminate" || !i.Outcome().Incomplete {
			t.Fatalf("expiry: %v %#v", err, findings)
		}
	}
}

func TestTransferIncompleteMetadataAndTerminalState(t *testing.T) {
	base := func() store.InputLimitsRecord {
		return store.InputLimitsRecord{Kind: "transfer", Fields: map[string]store.InputLimitsField{"path": input("target"), "state": input("receiving"), "direction": input("upload"), "data": input(`{"nextOffset":0}`), "outstandingBytes": input("0"), "chunkBytes": input("0")}}
	}
	cases := []struct {
		name   string
		change func(*store.InputLimitsRecord)
		clear  bool
	}{
		{"missing-state", func(r *store.InputLimitsRecord) { delete(r.Fields, "state") }, false},
		{"closed", func(r *store.InputLimitsRecord) { r.Fields["state"] = input("closed") }, true},
		{"missing-direction", func(r *store.InputLimitsRecord) { delete(r.Fields, "direction") }, false},
		{"missing-data", func(r *store.InputLimitsRecord) { delete(r.Fields, "data") }, false},
		{"bad-data", func(r *store.InputLimitsRecord) { r.Fields["data"] = input("{}") }, false},
		{"missing-reservation", func(r *store.InputLimitsRecord) { delete(r.Fields, "outstandingBytes") }, false},
		{"invalid-reservation", func(r *store.InputLimitsRecord) { r.Fields["outstandingBytes"] = input("-1") }, false},
		{"missing-chunk-total", func(r *store.InputLimitsRecord) { delete(r.Fields, "chunkBytes") }, false},
		{"download-missing-data", func(r *store.InputLimitsRecord) {
			r.Fields["state"] = input("ready")
			r.Fields["direction"] = input("download")
			delete(r.Fields, "data")
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			i, findings := testInspector(t, nil)
			r := base()
			tc.change(&r)
			if err := i.Record(r); err != nil {
				t.Fatal(err)
			}
			if tc.clear && (len(*findings) != 0 || i.Outcome().Incomplete) {
				t.Fatalf("closed transfer blocked: %#v", *findings)
			}
			if !tc.clear && (len(*findings) != 1 || (*findings)[0].Category != "indeterminate" || !i.Outcome().Incomplete) {
				t.Fatalf("missing facts accepted: %#v", *findings)
			}
		})
	}
	cause := errors.New("report sink unavailable")
	i := New(context.Background(), nil, func(store.InputLimitsIdentity) error { return nil }, func(Finding) error { return cause })
	if err := i.Identity(store.InputLimitsIdentity{}); err != nil {
		t.Fatal(err)
	}
	r := base()
	r.Fields["data"] = input(`{"nextOffset":5242881}`)
	if err := i.Record(r); !errors.Is(err, cause) {
		t.Fatalf("upload violation sink error lost: %v", err)
	}
}
