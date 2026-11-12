package sessionprotocol

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestSendMessageOriginIsOptionalAndStrict(t *testing.T) {
	for _, image := range []bool{false, true} {
		for _, tc := range []struct {
			name   string
			origin any
			valid  bool
		}{
			{"legacy", nil, true},
			{"user", "user", true},
			{"daynight", "daynight", true},
			{"empty", "", false},
			{"unknown", "system", false},
			{"number", 1, false},
			{"null", nil, false},
		} {
			name := tc.name
			if image {
				name += " image"
			}
			t.Run(name, func(t *testing.T) {
				command := relayObject(t, commandFixture(t, "send-message"))
				payload := command["payload"].(map[string]any)
				if image {
					var spec ImageUploadSpec
					if err := json.Unmarshal(imageSpecBytes(), &spec); err != nil {
						t.Fatal(err)
					}
					payload["content"] = []any{map[string]any{"type": "image", "imageId": uuid.NewString(), "uploadId": uuid.NewString(), "resourceId": uuid.NewString(), "sha256": spec.SHA256, "byteLength": "1"}}
					payload["target"], payload["draftId"], payload["draftRevision"], payload["expectedImageCapabilityRevision"] = spec.Target, uuid.NewString(), "1", "1"
					command["contentRevision"] = ContentRevision
				}
				if tc.name != "legacy" {
					payload["origin"] = tc.origin
				}
				decoded, err := DecodeCommand(relayJSON(t, command))
				if (err == nil) != tc.valid {
					t.Fatalf("origin validity = %v, want %v: %v", err == nil, tc.valid, err)
				}
				if err == nil {
					actual := relayObject(t, decoded.Payload)
					origin, present := actual["origin"]
					if present != (tc.name != "legacy") || origin != tc.origin {
						t.Fatal("command changed origin", actual)
					}
				}
			})
		}
	}
}

func TestTimelineOriginBelongsOnlyToUserMessages(t *testing.T) {
	for _, source := range []bool{false, true} {
		for _, tc := range []struct {
			name   string
			origin any
			valid  bool
		}{
			{"legacy", nil, true}, {"user", "user", true}, {"daynight", "daynight", true},
			{"null", nil, false}, {"unknown", "system", false}, {"boolean", true, false},
		} {
			for _, kind := range []string{"user_message", "assistant_message"} {
				entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": kind, "content": []any{map[string]any{"type": "text", "text": "notification"}}}
				if source {
					delete(entry, "entrySeq")
				}
				if tc.name != "legacy" {
					entry["origin"] = tc.origin
				}
				decode := DecodeTimeline
				if source {
					decode = DecodeSourceTimeline
				}
				actual, err := decode(relayJSON(t, entry))
				valid := tc.valid && (kind == "user_message" || tc.name == "legacy")
				if (err == nil) != valid {
					t.Fatalf("%s %s source=%v: %v, want valid=%v", kind, tc.name, source, err, valid)
				}
				if valid && tc.name != "legacy" && stringField(actual.Data["origin"]) != tc.origin {
					t.Fatal("timeline lost origin", actual)
				}
			}
		}
	}
}

func TestArchiveReadersPreserveNotificationOrigin(t *testing.T) {
	legacy := archiveFixture()
	entry := legacy["entries"].([]any)[0].(map[string]any)
	entry["kind"], entry["origin"] = "user_message", "daynight"
	archive, err := DecodeArchive(relayJSON(t, legacy))
	if err != nil || len(archive.Entries) != 1 || stringField(archive.Entries[0].Data["origin"]) != "daynight" {
		t.Fatal("legacy archive lost notification origin", archive, err)
	}
	timeline, err := DecodeArchiveTimeline(relayJSON(t, map[string]any{"entries": legacy["entries"]}))
	if err != nil || len(timeline.Entries) != 1 || stringField(timeline.Entries[0].Data["origin"]) != "daynight" {
		t.Fatal("external archive lost notification origin", timeline, err)
	}
}
