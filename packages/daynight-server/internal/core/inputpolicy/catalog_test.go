package inputpolicy

import "testing"

func TestCatalog(t *testing.T) {
	if Version == "" {
		t.Fatal("missing version")
	}
	first := Catalog()
	seen := map[string]bool{}
	for _, e := range first {
		if e.ID == "" || e.Max <= 0 || e.Unit == "" || seen[e.ID] {
			t.Fatalf("invalid entry: %+v", e)
		}
		seen[e.ID] = true
	}
	first[0].ID = "modified"
	if Catalog()[0].ID == "modified" {
		t.Fatal("catalog shares state")
	}
}

func TestResponseAndRangePolicies(t *testing.T) {
	entries := make(map[string]Entry)
	for _, entry := range Catalog() {
		entries[entry.ID] = entry
	}
	for _, tc := range []struct {
		id   string
		max  int64
		unit string
	}{
		{"attachment.metadataPage", 2 << 20, "bytes"},
		{"bot.candidatePage", 8 << 20, "bytes"},
		{"bot.cwd", 4096, "bytes"},
		{"identity.invitation.page", 256 << 10, "bytes"},
		{"identity.pat.page", 256 << 10, "bytes"},
		{"project.page", 4 << 20, "bytes"},
		{"project.member.page", 4 << 20, "bytes"},
		{"team.page", 4 << 20, "bytes"},
		{"team.member.page", 4 << 20, "bytes"},
		{"task.page", 4 << 20, "bytes"},
		{"task.assignee.page", 4 << 20, "bytes"},
		{"task.resource", 512 << 10, "bytes"},
		{"task.sync", 64 << 20, "bytes"},
		{"worker.page", 8 << 20, "bytes"},
		{"search.expression", 8192, "bytes"},
		{"search.terms", 128, "items"},
		{"search.depth", 32, "levels"},
		{"search.page", 2 << 20, "bytes"},
		{"step.title", 1024, "bytes"},
		{"step.description", 64 << 10, "bytes"},
		{"step.mcp.cursor", 2048, "bytes"},
		{"terminal.history.cursor", 1024, "bytes"},
		{"identity.upstream.timeout", 15, "seconds"},
		{"transport.rest.body", 1 << 20, "bytes"},
		{"transport.mcp.body", 4 << 20, "bytes"},
		{"transport.mcp.inputOperations", 16, "items"},
		{"transport.cursor", 16 << 10, "bytes"},
		{"transport.query", 24 << 10, "bytes"},
		{"transport.target", 48 << 10, "bytes"},
		{"transport.headers", 64 << 10, "bytes"},
		{"transport.json.readTimeout", 15, "seconds"},
		{"transport.attachment.readTimeout", 60, "seconds"},
		{"transport.archive.readTimeout", 120, "seconds"},
	} {
		v, ok := entries[tc.id]
		if !ok || v.Max != tc.max || v.Unit != tc.unit || v.HasMin || v.UpperExclusive {
			t.Errorf("%s: %+v", tc.id, v)
		}
	}
	for _, tc := range []struct {
		id        string
		min, max  int64
		exclusive bool
		unit      string
	}{
		{"worker.maxConcurrent", 1, 64, false, "value"},
		{"worker.pollIntervalMs", 1000, 60000, false, "value"},
		{"worker.recoveryLimit", 0, 10, false, "value"},
		{"worker.active.window", 0, 120, true, "seconds"},
		{"bot.name", 1, 40, false, "code points"},
		{"identity.pat.name", 1, 100, false, "code points"},
		{"attachment.content", 0, 5 << 20, false, "bytes"},
	} {
		v, ok := entries[tc.id]
		if !ok || !v.HasMin || v.Min != tc.min || v.Max != tc.max || v.UpperExclusive != tc.exclusive || v.Unit != tc.unit {
			t.Errorf("%s: %+v", tc.id, v)
		}
	}
}
