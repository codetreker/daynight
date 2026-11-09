package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func TestUploadChunkReceiptSurvivesCleanupFailureInMCP(t *testing.T) {
	f := newEntryFixture(t)
	transferID, chunkID := testTeamID, testTargetID
	var expected mcptransfer.UploadInput
	var data map[string]any
	var failure error
	calls := 0
	if err := RegisterUploadTools(f.entry, attachmentUploadOperation(func(ctx context.Context, actor transfercore.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
		calls++
		if ctx.Err() != nil || actor.Principal.UserID != "alice" || actor.AuthorityKind != "pat" || actor.AuthorityID != "credential-alice" || project != testProjectID || task != testTargetID || !reflect.DeepEqual(input, expected) {
			t.Errorf("unexpected upload call: actor=%+v project=%s task=%s input=%+v want=%+v", actor, project, task, input, expected)
		}
		return data, failure
	})); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := func(action string) map[string]any {
		return map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": action, "transferId": transferID}
	}
	expected = mcptransfer.UploadInput{Action: "begin", TransferID: transferID, Path: "file", ContentType: "text/plain"}
	data = map[string]any{"state": "receiving", "transferId": transferID, "nextOffset": "0"}
	begin := args("begin")
	begin["path"], begin["contentType"] = "file", "text/plain"
	invitationCall(t, client, "task_attachment_put", begin, false)
	chunk := args("chunk")
	chunk["chunkId"], chunk["offset"], chunk["contentBase64"] = chunkID, "0", "YQ=="
	expected = mcptransfer.UploadInput{Action: "chunk", TransferID: transferID, ChunkID: chunkID, Offset: "0", ContentBase64: "YQ=="}
	digest := sha256.Sum256([]byte("a"))
	expires := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)
	failure = errors.New("private gate close failed")
	for _, receipt := range []string{"accepted", "already_accepted"} {
		data = map[string]any{"transferId": transferID, "chunkId": chunkID, "receipt": receipt, "offset": "0", "acceptedBytes": "1", "nextOffset": "1", "sha256": hex.EncodeToString(digest[:]), "expiresAt": expires}
		fault := object(t, invitationCall(t, client, "task_attachment_put", chunk, true)["error"])
		refs := object(t, fault["refs"])
		if fault["code"] != "internal_error" || fault["writeOutcome"] != nil || refs["transferId"] != transferID || refs["chunkId"] != chunkID || refs["receipt"] != receipt || refs["offset"] != "0" || refs["acceptedBytes"] != "1" || refs["nextOffset"] != "1" || refs["sha256"] != hex.EncodeToString(digest[:]) || refs["expiresAt"] != expires {
			t.Fatalf("chunk receipt lost or target outcome invented: %#v", fault)
		}
	}
	expected = mcptransfer.UploadInput{Action: "status", TransferID: transferID}
	data, failure = map[string]any{"state": "receiving", "nextOffset": "1"}, nil
	status := object(t, invitationCall(t, client, "task_attachment_put", args("status"), false)["data"])
	if status["nextOffset"] != "1" || calls != 4 {
		t.Fatalf("status=%#v calls=%d", status, calls)
	}
}
