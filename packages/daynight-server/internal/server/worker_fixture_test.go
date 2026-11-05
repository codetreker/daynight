package server

import "github.com/google/uuid"

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

const workerConfigurationHeader = "Daynight-Worker-Configuration"
