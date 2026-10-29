package taskproperties

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestPropertyArgumentUsesServerDefinitionForStringValues(t *testing.T) {
	for _, value := range []string{"", "xxx", "  ", "line\n中文\x00", "123", "null", "[]", `"unfinished`} {
		quoted, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, argument := range []string{value, string(quoted)} {
			patch, err := DecodePropertyArgument("worker.signaling", argument)
			if err != nil || patch.WorkerSignaling == nil || *patch.WorkerSignaling != value || patch.PullRequests != nil {
				t.Fatalf("string argument changed: %q => %#v, %v", argument, patch, err)
			}
		}
	}
	patch, err := DecodePropertyArgument("worker.signaling", " \n\t\"JSON string\" \r\n")
	if err != nil || patch.WorkerSignaling == nil || *patch.WorkerSignaling != "JSON string" {
		t.Fatalf("whitespace around a JSON string was not decoded: %#v %v", patch, err)
	}
}

func TestPropertyArgumentUsesExistingTypedPatchCodec(t *testing.T) {
	value := `[{"url":"opaque\u0000","title":"中文"},{"url":"opaque\u0000","title":"中文"}]`
	patch, err := DecodePropertyArgument("pullRequests", value)
	want := []core.PullRequestProperty{{URL: "opaque\x00", Title: "中文"}, {URL: "opaque\x00", Title: "中文"}}
	if err != nil || patch.PullRequests == nil || !reflect.DeepEqual(*patch.PullRequests, want) || patch.WorkerSignaling != nil {
		t.Fatalf("array property changed: %#v %v", patch, err)
	}
	patch, err = DecodePropertyArgument("worker", `{"signaling":"nested"}`)
	if err != nil || patch.WorkerSignaling == nil || *patch.WorkerSignaling != "nested" {
		t.Fatalf("object property did not use the patch codec: %#v %v", patch, err)
	}
	for _, value := range []string{"", "not JSON", "[", `null`, `false`, `123`, `"[]"`, `{}`, `[{}]`, `[{"url":"x","title":"y","url":"z"}]`} {
		if _, err := DecodePropertyArgument("pullRequests", value); err == nil {
			t.Fatalf("invalid array argument was accepted: %q", value)
		}
	}
	for _, value := range []string{`{}`, `null`, `{"signaling":1}`, `{"signaling":"x","claimId":"changed"}`, `{"signaling":"x","signaling":"y"}`} {
		if _, err := DecodePropertyArgument("worker", value); err == nil {
			t.Fatalf("invalid worker object argument was accepted: %q", value)
		}
	}
}

func TestPropertyArgumentRejectsUnknownProtectedAndMalformedPathsBeforeTyping(t *testing.T) {
	for _, property := range []string{
		"", ".", ".worker.signaling", "worker.", "worker..signaling", "worker/signaling", "worker.signaling/",
		"unknown", "properties.worker.signaling", "pullRequests.0.url", "worker.signaling.extra", strings.Repeat("worker.", 10000) + "signaling",
		"worker.claimId", "worker.state", "worker.userId", "worker.workerId", "worker.machine.name", "worker.platform",
		"worker.agent", "worker.agentControlMode", "worker.worktreeId", "worker.phase", "worker.herdr", "worker.nativeSessionId", "worker.claimedAt",
	} {
		if _, err := DecodePropertyArgument(property, "invalid JSON"); err == nil || strings.Contains(err.Error(), "value must be valid JSON") {
			t.Fatalf("property path was not validated before value typing: %q %v", property, err)
		}
	}
}

func TestPropertyRemovalUsesRegisteredDefaults(t *testing.T) {
	patch, err := DecodePropertyRemoval("worker.signaling")
	if err != nil || patch.WorkerSignaling == nil || *patch.WorkerSignaling != "" || patch.PullRequests != nil {
		t.Fatalf("string removal did not produce its empty default: %#v %v", patch, err)
	}
	patch, err = DecodePropertyRemoval("pullRequests")
	if err != nil || patch.PullRequests == nil || *patch.PullRequests == nil || len(*patch.PullRequests) != 0 || patch.WorkerSignaling != nil {
		t.Fatalf("array removal did not produce an empty list: %#v %v", patch, err)
	}
	for _, property := range []string{"", ".", "..", "worker", "unknown", "worker.claimId", "worker.signaling.extra", "worker/signaling"} {
		if _, err := DecodePropertyRemoval(property); err == nil {
			t.Fatalf("invalid or protected property removal was accepted: %q", property)
		}
	}
}
