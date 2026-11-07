package inputlimitreport

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestVerifyClear(t *testing.T) {
	now := time.Date(2026, 11, 7, 9, 0, 0, 0, time.UTC)
	db := DatabaseIdentity{Host: "localhost", Port: "5432", ServerAddress: "127.0.0.1", ServerPort: "5432", SystemIdentifier: "123456", Database: "fixture", DatabaseOID: "42", Schema: "public", Relations: map[string]string{"tasks": "public/123"}}
	expected := GateContext{SourceSHA: strings.Repeat("a", 40), PolicySHA: strings.Repeat("b", 64), SpecSHA: strings.Repeat("c", 64), StorageRootSHA: strings.Repeat("e", 64), PolicyVersion: "v1", Database: db, WindowStart: now.Add(-time.Minute), Now: now, RequiredKinds: []string{"task", "worker"}}
	clean := false
	header := Header{Type: "header", SourceSHA: expected.SourceSHA, SourceModified: &clean, PolicySHA: expected.PolicySHA, SpecSHA: expected.SpecSHA, StorageRootSHA: expected.StorageRootSHA, PolicyVersion: expected.PolicyVersion, Identity: db}
	header.Identity.Snapshot = "10:11:"
	header.Identity.ObservedAt = now.Add(-time.Second)
	summary := Summary{Type: "summary", Complete: true, Clear: true, Counts: map[string]int64{"task": 0, "worker": 1}}
	encode := func(h Header, s Summary) string {
		a, err := json.Marshal(h)
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		return string(a) + "\n" + string(b) + "\n"
	}
	valid := encode(header, summary)
	if err := VerifyClear(strings.NewReader(valid), expected); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"source":                 strings.Replace(valid, expected.SourceSHA, strings.Repeat("d", 40), 1),
		"policy":                 strings.Replace(valid, expected.PolicySHA, strings.Repeat("d", 64), 1),
		"spec":                   strings.Replace(valid, expected.SpecSHA, strings.Repeat("d", 64), 1),
		"storage root":           strings.Replace(valid, expected.StorageRootSHA, strings.Repeat("d", 64), 1),
		"database":               strings.Replace(valid, "fixture", "other", 1),
		"server address":         strings.Replace(valid, `"ServerAddress":"127.0.0.1"`, `"ServerAddress":"127.0.0.2"`, 1),
		"server port":            strings.Replace(valid, `"ServerPort":"5432"`, `"ServerPort":"5433"`, 1),
		"system identifier":      strings.Replace(valid, `"SystemIdentifier":"123456"`, `"SystemIdentifier":"654321"`, 1),
		"schema":                 strings.Replace(valid, `"Schema":"public"`, `"Schema":"other"`, 1),
		"relation":               strings.Replace(valid, "public/123", "public/124", 1),
		"modified":               strings.Replace(valid, `"sourceModified":false`, `"sourceModified":true`, 1),
		"missing modified":       strings.Replace(valid, `"sourceModified":false,`, "", 1),
		"old window":             strings.Replace(valid, header.Identity.ObservedAt.Format(time.RFC3339), now.Add(-time.Hour).Format(time.RFC3339), 1),
		"future":                 strings.Replace(valid, header.Identity.ObservedAt.Format(time.RFC3339), now.Add(time.Second).Format(time.RFC3339), 1),
		"incomplete":             strings.Replace(valid, `"complete":true`, `"complete":false`, 1),
		"not clear":              strings.Replace(valid, `"clear":true`, `"clear":false`, 1),
		"finding":                strings.Replace(valid, `"findings":0`, `"findings":1`, 1),
		"uncertain":              strings.Replace(valid, `"indeterminate":0`, `"indeterminate":1`, 1),
		"scope":                  strings.Replace(valid, `"worker":1`, `"other":1`, 1),
		"duplicate key":          strings.Replace(valid, `"clear":true`, `"clear":false,"clear":true`, 1),
		"complete alias attack":  strings.Replace(valid, `"complete":true`, `"complete":false,"Complete":true`, 1),
		"clear alias attack":     strings.Replace(valid, `"clear":true`, `"clear":false,"Clear":true`, 1),
		"source alias attack":    strings.Replace(valid, `"sourceModified":false`, `"sourceModified":true,"SourceModified":false`, 1),
		"database alias attack":  strings.Replace(valid, `"Database":"fixture"`, `"Database":"other","database":"fixture"`, 1),
		"single summary alias":   strings.Replace(valid, `"complete":true`, `"Complete":true`, 1),
		"single header alias":    strings.Replace(valid, `"sourceSha"`, `"SourceSha"`, 1),
		"single identity alias":  strings.Replace(valid, `"Database"`, `"database"`, 1),
		"unicode fold collision": strings.Replace(valid, `"clear":true`, `"clear":true,"k":1,"K":2`, 1),
		"finding record":         strings.Replace(valid, "\n", "\n{\"type\":\"finding\"}\n", 1),
		"after summary":          valid + "{}\n",
		"truncated":              strings.TrimSuffix(valid, "\n"),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if err := VerifyClear(strings.NewReader(data), expected); !errors.Is(err, ErrGate) {
				t.Fatalf("got %v", err)
			}
		})
	}
	for _, mutate := range []func(*GateContext){
		func(e *GateContext) { e.SourceSHA = "" },
		func(e *GateContext) { e.Database = DatabaseIdentity{} },
		func(e *GateContext) { e.WindowStart = now.Add(time.Second) },
		func(e *GateContext) { e.RequiredKinds = nil },
	} {
		e := expected
		mutate(&e)
		if err := VerifyClear(strings.NewReader(valid), e); !errors.Is(err, ErrGate) {
			t.Fatal(err)
		}
	}
}

func TestIdentitySchemaRequiresObjectAndCanonicalKeys(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		want        bool
	}{
		{"valid", `{"identity":{"Host":"host","DatabaseOID":"42"}}`, true},
		{"malformed header", `{"identity":`, false},
		{"absent identity", `{"type":"header"}`, false},
		{"null identity", `{"identity":null}`, false},
		{"array identity", `{"identity":[]}`, false},
		{"noncanonical identity field", `{"identity":{"serverAddress":"host"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := canonicalIdentity([]byte(tc.input)); got != tc.want {
				t.Fatalf("got %t, want %t", got, tc.want)
			}
		})
	}
}

func TestUniqueJSONKeysNestedAndMalformed(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		want        bool
	}{
		{"nested array", `{"items":[{"id":1},{"id":2},[true,null,3]]}`, true},
		{"nested collision", `{"items":[{"id":1,"ID":2}]}`, false},
		{"escaped collision", `{"nested":{"a":1,"\u0041":2}}`, false},
		{"empty", ``, false},
		{"missing object value", `{"item":`, false},
		{"unfinished object", `{"item":true`, false},
		{"unfinished array", `{"items":[true`, false},
		{"object without key", `{true}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := uniqueJSONKeys([]byte(tc.input)); got != tc.want {
				t.Fatalf("got %t, want %t", got, tc.want)
			}
		})
	}
}
