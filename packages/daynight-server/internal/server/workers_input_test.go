package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/google/uuid"
)

func workerSnapshotReportBody() map[string]any {
	now := "2026-10-29T00:00:00Z"
	probe := func(value any) map[string]any { return map[string]any{"state": "ok", "checkedAt": now, "value": value} }
	return map[string]any{"machine": map[string]any{"id": uuid.NewString(), "name": "Private worker machine"}, "platform": "linux", "workingDirectory": "/private/work", "sampledAt": now,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 12.5}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("0.9.5"), "codex": map[string]any{"state": "not_installed", "checkedAt": now}, "copilot": map[string]any{"state": "error", "checkedAt": now, "code": "timeout"}},
		"taskInventory": map[string]any{"observedAt": now, "claims": []any{}}}
}

func TestWorkerReportStrictInputObjects(t *testing.T) {
	for _, key := range workerReportFields {
		body := workerSnapshotReportBody()
		delete(body, key)
		fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := workerReportInput(fields); err == nil {
			t.Errorf("missing %s accepted", key)
		}
	}
	for _, key := range workerReportFields {
		if key == "taskInventory" {
			continue
		}
		body := workerSnapshotReportBody()
		body[key] = nil
		fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := workerReportInput(fields); err == nil {
			t.Errorf("null %s accepted", key)
		}
	}
	base := jsonBody(t, workerSnapshotReportBody())
	for _, test := range []struct{ old, replacement string }{
		{`"machine":{`, `"machine":{"unknown":true,`}, {`"name":"Private worker machine"`, `"name":null`},
		{`"platform":"linux"`, `"platform":false`}, {`"workingDirectory":"/private/work"`, `"workingDirectory":null`},
		{`"sampledAt":"2026-10-29T00:00:00Z"`, `"sampledAt":"bad"`},
		{`"state":"ok"`, `"state":"unknown"`}, {`"state":"ok"`, `"state":"ok","state":"ok"`},
		{`"checkedAt":"2026-10-29T00:00:00Z"`, `"checkedAt":false`},
		{`"arch":"x64"`, `"arch":2`}, {`"logicalProcessors":4`, `"logicalProcessors":null`},
		{`"model":"CPU"`, `"model":false`}, {`"usagePercent":12.5`, `"usagePercent":null`}, {`"usagePercent":12.5`, `"usagePercent":"12"`},
		{`"usedBytes":4`, `"usedBytes":1.1`}, {`"totalBytes":8`, `"totalBytes":true`}, {`"availableBytes":8`, `"availableBytes":-1`},
		{`"daynight":"1.0.0"`, `"daynight":null`}, {`"state":"not_installed"`, `"state":"not_installed","value":"bad"`},
		{`"claims":[]`, `"claims":null`}, {`"claims":[]`, `"claims":{}`}, {`"claims":[]`, `"claims":[{"projectId":"x","taskId":"y"}]`},
		{`"os":{`, `"os":{"code":"timeout",`}, {`"memory":{`, `"memory":{"unknown":true,`}, {`"versions":{`, `"versions":{"unknown":true,`},
	} {
		if !strings.Contains(base, test.old) {
			t.Fatalf("fixture text missing %s", test.old)
		}
		body := strings.Replace(base, test.old, test.replacement, 1)
		fields, err := jsonobject.Decode([]byte(body), "report", workerReportFields...)
		if err == nil {
			_, err = workerReportInput(fields)
		}
		if err == nil {
			t.Errorf("invalid nested input accepted: %s", body)
		}
	}
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	fields, _ := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if report, err := workerReportInput(fields); err != nil || report.TaskInventory != nil {
		t.Fatal("explicit unknown inventory rejected", err)
	}
	body = workerSnapshotReportBody()
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00+02:00", "claims": []any{map[string]any{"projectId": uuid.NewString(), "taskId": uuid.NewString(), "claimId": uuid.NewString()}}}
	fields, _ = jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if report, err := workerReportInput(fields); err != nil || len(report.TaskInventory.Claims) != 1 || report.TaskInventory.ObservedAt.Location().String() != "UTC" {
		t.Fatal("valid inventory rejected", err)
	}
}

func TestWorkerSafeIntegerParsing(t *testing.T) {
	for raw, want := range map[string]int64{"0": 0, "-0": 0, "0e999999999999": 0, "1.0": 1, "1e3": 1000, "12300e-2": 123, "9007199254740991": 9007199254740991} {
		got, err := workerIntegerInput(json.RawMessage(raw))
		if err != nil || got != want {
			t.Errorf("%s: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "null", "true", `"1"`, "[]", "{}", "-1", "1.1", "1e-1", "9007199254740992", "9007199254740991.1", "1e999999999999", "1e-999999999999", "1e30", "9223372036854775807"} {
		if _, err := workerIntegerInput(json.RawMessage(raw)); err == nil {
			t.Errorf("unsafe integer accepted: %s", raw)
		}
	}
}

func TestWorkerReportTimestampSyntax(t *testing.T) {
	for _, value := range []string{"2026-10-29T00:00:00Z", "2026-10-29T00:00:00.123456789Z", "2026-10-29T00:00:00.123+02:30", "2026-10-29t00:00:00z", "2026-10-29T00:00:00-03:15"} {
		fields := map[string]json.RawMessage{"sampledAt": json.RawMessage(`"` + value + `"`)}
		stamp, err := workerTimeInput(fields, "sampledAt")
		if err != nil || stamp.Location().String() != "UTC" {
			t.Errorf("valid timestamp %s: %v", value, err)
		}
	}
	for _, value := range []string{"2026-10-29T00:00:00+24:00", "2026-10-29T00:00:00+00:60", "2026-10-29T00:00:00,1Z", "2026-10-29T24:00:00Z", "2026-02-30T00:00:00Z", "2026-10-29T0:00:00Z", "2026-10-29 00:00:00Z"} {
		fields := map[string]json.RawMessage{"sampledAt": json.RawMessage(`"` + value + `"`)}
		if _, err := workerTimeInput(fields, "sampledAt"); err == nil {
			t.Errorf("invalid timestamp accepted: %s", value)
		}
	}
}
