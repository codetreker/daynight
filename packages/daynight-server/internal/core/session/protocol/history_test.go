package sessionprotocol

import (
	"strings"
	"testing"
)

func TestInspectionContentResultsAcceptBoundedReadUnions(t *testing.T) {
	for _, raw := range []string{
		`{"kind":"inspect_page","historyEpoch":"11111111-1111-4111-8111-111111111111","items":[],"beforeCursor":null,"hasMoreBefore":false}`,
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
