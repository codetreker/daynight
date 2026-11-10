package sessionprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestInspectionCoverageRequiresConsistentCompleteOrPartialFacts(t *testing.T) {
	base := `{"kind":"inspect_page","historyEpoch":"11111111-1111-4111-8111-111111111111","items":[],"beforeCursor":null,"hasMoreBefore":false`
	for _, value := range []struct {
		name, coverage string
		valid          bool
	}{
		{"complete", `{"state":"complete","reason":null}`, true},
		{"entry", `{"state":"partial","reason":"entry_truncated"}`, true},
		{"resource", `{"state":"partial","reason":"resource_unavailable"}`, true},
		{"missing", ``, false},
		{"null", `null`, false},
		{"missing_reason", `{"state":"complete"}`, false},
		{"missing_state", `{"reason":null}`, false},
		{"unknown_state", `{"state":"unknown","reason":null}`, false},
		{"unknown_reason", `{"state":"partial","reason":"unknown"}`, false},
		{"complete_with_reason", `{"state":"complete","reason":"entry_truncated"}`, false},
		{"partial_without_reason", `{"state":"partial","reason":null}`, false},
		{"extra", `{"state":"complete","reason":null,"extra":true}`, false},
	} {
		t.Run(value.name, func(t *testing.T) {
			raw := base
			if value.coverage != "" {
				raw += `,"coverage":` + value.coverage
			}
			raw += `}`
			got, err := DecodeContentResult([]byte(raw))
			if !value.valid {
				if err == nil {
					t.Fatal("invalid history coverage accepted", raw)
				}
				return
			}
			if err != nil {
				t.Fatal("valid history coverage refused", err)
			}
			encoded, err := MarshalWire(got)
			if err != nil {
				t.Fatal(err)
			}
			var roundtrip map[string]json.RawMessage
			if err = json.Unmarshal(encoded, &roundtrip); err != nil || string(roundtrip["coverage"]) != value.coverage {
				t.Fatalf("coverage roundtrip changed: %s %v", encoded, err)
			}
		})
	}
}

func TestInspectionContentResultsAcceptBoundedReadUnions(t *testing.T) {
	for _, raw := range []string{
		`{"kind":"inspect_page","historyEpoch":"11111111-1111-4111-8111-111111111111","items":[],"beforeCursor":null,"hasMoreBefore":false,"coverage":{"state":"complete","reason":null}}`,
		`{"kind":"entry_chunk","historyEpoch":"11111111-1111-4111-8111-111111111111","entryId":"22222222-2222-4222-8222-222222222222","revision":"1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":"3","offset":"0","fragment":"中","nextCursor":null,"eof":true}`,
	} {
		got, err := DecodeContentResult([]byte(raw))
		if err != nil {
			t.Fatalf("new content read rejected: %s: %v", raw, err)
		}
		encoded, err := MarshalWire(got)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = DecodeContentResult(encoded); err != nil {
			t.Fatalf("roundtrip: %s: %v", encoded, err)
		}
	}
}

func TestInspectionItemRejectsUnknownKindAndIncorrectRole(t *testing.T) {
	item := `{"entryId":"11111111-1111-4111-8111-111111111111","entrySeq":"1","revision":"1","kind":"reasoning","role":null,"timestamp":null,"body":null,"truncated":true,"contentRef":{"cursor":"cursor","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":"9"},"resources":[],"resourcesTruncated":false}`
	for _, bad := range []string{strings.Replace(item, `"kind":"reasoning"`, `"kind":"invented"`, 1), strings.Replace(item, `"role":null`, `"role":"user"`, 1)} {
		if inspectionItem([]byte(bad)) {
			t.Fatal("invalid bounded metadata accepted", bad)
		}
	}
}

func TestEntryChunkRejectsImpossibleOffsetsAndEmptyProgress(t *testing.T) {
	valid := `{"kind":"entry_chunk","historyEpoch":"11111111-1111-4111-8111-111111111111","entryId":"22222222-2222-4222-8222-222222222222","revision":"1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":"3","offset":"0","fragment":"中","nextCursor":null,"eof":true}`
	for _, raw := range []string{strings.Replace(valid, `"offset":"0"`, `"offset":"3"`, 1), strings.Replace(valid, `"byteLength":"3"`, `"byteLength":"0"`, 1), strings.Replace(valid, `"fragment":"中"`, `"fragment":""`, 1)} {
		if _, err := DecodeContentResult([]byte(raw)); err == nil {
			t.Fatal("invalid chunk accepted", raw)
		}
	}
}
