package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	uploadservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// dropUploadResponses consumes the configured responses while withholding them
// from the client. The transport does not retry submitted requests.
type dropUploadResponses struct {
	base        http.RoundTripper
	beginDrops  atomic.Int32
	commitDrops atomic.Int32
}

func (d *dropUploadResponses) RoundTrip(req *http.Request) (*http.Response, error) {
	action := ""
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		req.Body = io.NopCloser(bytes.NewReader(body))
		var call struct {
			Method string `json:"method"`
			Params struct {
				Name      string `json:"name"`
				Arguments struct {
					Action string `json:"action"`
				} `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(body, &call) == nil {
			if call.Method == "tools/call" && call.Params.Name == "task_attachment_put" {
				action = call.Params.Arguments.Action
			}
		}
	}
	response, err := d.base.RoundTrip(req)
	if err != nil {
		return response, err
	}
	var counter *atomic.Int32
	var limit int32
	switch action {
	case "begin":
		counter, limit = &d.beginDrops, 2
	case "commit":
		counter, limit = &d.commitDrops, 1
	default:
		return response, nil
	}
	for {
		current := counter.Load()
		if current >= limit {
			return response, nil
		}
		if counter.CompareAndSwap(current, current+1) {
			break
		}
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("%s HTTP %d: %s", action, response.StatusCode, body)
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	closeErr := response.Body.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("injected lost %s response", action)
}

func TestMCPUploadRecoversLostBeginAndCommitResponses(t *testing.T) {
	principal := defaultHTTPPrincipal()
	token := defaultHTTPToken()
	files := attachmentTestFiles(t)
	uploads := &mcpUploadOperations{t: t}
	production, _ := newMCPOperationServer(t, map[string]model.Principal{token: principal}, files, func(app *service.App) { app.Uploads = uploads })
	origin := production.URL
	project := model.Project{ID: "e5555555-5555-4555-8555-555555555555"}
	task := model.Task{ID: "f6666666-6666-4666-8666-666666666666", ProjectID: project.ID, Title: "MCP upload owner", Version: 1}
	actor := transfer.Actor{Principal: principal, AuthorityKind: "pat", AuthorityID: principal.CredentialID}
	client := mcpPATClient(t, origin, token)
	drop := &dropUploadResponses{base: mcpPATTransport{token: token}}
	lossClient := sdk.NewClient(&sdk.Implementation{Name: "mcp-response-loss", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	lossSession, err := lossClient.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: origin + "/mcp", HTTPClient: &http.Client{Transport: drop}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := lossSession.Close(); err != nil {
			t.Error(err)
		}
	})
	call := func(session *sdk.ClientSession, args map[string]any, wantError bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: args})
		if err != nil || result.IsError != wantError {
			t.Fatalf("upload %v: result=%+v error=%v", args["action"], result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope map[string]any
		if err := json.Unmarshal(encoded, &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope
	}
	object := func(value any) map[string]any {
		t.Helper()
		result, ok := value.(map[string]any)
		if !ok {
			t.Fatalf("expected object, got %#v", value)
		}
		return result
	}
	args := func(action string) map[string]any {
		return map[string]any{"projectId": project.ID, "taskId": task.ID, "action": action}
	}
	transferID := uuid.NewString()
	baseTime := time.Now().UTC()
	expiry := baseTime.Add(time.Hour)
	receiving := func(offset int64) map[string]any {
		return map[string]any{"transferId": transferID, "direction": "upload", "state": "receiving", "nextOffset": strconv.FormatInt(offset, 10), "expiresAt": expiry, "cleanupState": "pending"}
	}
	begin := args("begin")
	begin["transferId"], begin["path"], begin["contentType"] = transferID, "binary/combined.bin", "application/octet-stream"
	beginInput := uploadservice.UploadInput{Action: "begin", TransferID: transferID, Path: "binary/combined.bin", ContentType: "application/octet-stream"}
	beginResult := receiving(0)
	beginResult["maxChunkBytes"] = 512 << 10
	uploads.expect(actor, project.ID, task.ID, beginInput, beginResult, nil, 3)
	for i := int32(1); i <= 2; i++ {
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		_, err := lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: begin})
		cancel()
		if err == nil || drop.beginDrops.Load() != i {
			t.Fatalf("begin response %d was not lost: %v", i, err)
		}
	}
	started := object(call(client, begin, false)["data"])
	if started["transferId"] != transferID || started["state"] != "receiving" || started["nextOffset"] != "0" {
		t.Fatalf("begin: %#v", started)
	}
	mcpAttachmentCheck(t, started, mcpUploadExpectedData(beginResult))
	parts := [][]byte{bytes.Repeat([]byte{0, 0xff, 0x7f, 0x41}, (512<<10)/4), bytes.Repeat([]byte{0x80, 0, 0xfe}, 171)}
	all := bytes.Join(parts, nil)
	offset := int64(0)
	for _, part := range parts {
		chunk := args("chunk")
		chunkID := uuid.NewString()
		digest := sha256.Sum256(part)
		hash := hex.EncodeToString(digest[:])
		size := int64(len(part))
		chunk["transferId"], chunk["chunkId"], chunk["offset"] = transferID, chunkID, strconv.FormatInt(offset, 10)
		chunk["contentBase64"], chunk["sha256"] = base64.StdEncoding.EncodeToString(part), hash
		input := uploadservice.UploadInput{Action: "chunk", TransferID: transferID, ChunkID: chunkID, Offset: strconv.FormatInt(offset, 10), ContentBase64: base64.StdEncoding.EncodeToString(part), SHA256: hash}
		result := map[string]any{"transferId": transferID, "state": "receiving", "chunkId": chunkID, "offset": strconv.FormatInt(offset, 10), "acceptedBytes": strconv.FormatInt(size, 10), "nextOffset": strconv.FormatInt(offset+size, 10), "sha256": hash, "receipt": "accepted", "expiresAt": expiry}
		uploads.expect(actor, project.ID, task.ID, input, result, nil, 1)
		receipt := object(call(client, chunk, false)["data"])
		mcpAttachmentCheck(t, receipt, mcpUploadExpectedData(result))
		offset += size
		if receipt["receipt"] != "accepted" || receipt["sha256"] != hash || receipt["nextOffset"] != strconv.FormatInt(offset, 10) {
			t.Fatalf("chunk: %#v", receipt)
		}
	}
	status := args("status")
	status["transferId"] = transferID
	statusInput := uploadservice.UploadInput{Action: "status", TransferID: transferID}
	uploads.expect(actor, project.ID, task.ID, statusInput, receiving(offset), nil, 1)
	observed := object(call(client, status, false)["data"])
	if observed["state"] != "receiving" || observed["nextOffset"] != strconv.Itoa(len(all)) {
		t.Fatalf("before commit: %#v", observed)
	}
	mcpAttachmentCheck(t, observed, mcpUploadExpectedData(receiving(offset)))
	whole := sha256.Sum256(all)
	wholeHash := hex.EncodeToString(whole[:])
	total := int64(len(all))
	commit := args("commit")
	commit["transferId"], commit["totalBytes"], commit["sha256"] = transferID, strconv.FormatInt(total, 10), wholeHash
	operationID := uuid.NewString()
	metadata := map[string]any{"path": "binary/combined.bin", "contentType": "application/octet-stream", "sizeBytes": strconv.FormatInt(total, 10), "createdAt": baseTime, "updatedAt": baseTime}
	confirmed := map[string]any{"transferId": transferID, "direction": "upload", "state": "cleanup_pending", "nextOffset": strconv.FormatInt(total, 10), "expiresAt": expiry, "cleanupState": "pending", "operationId": operationID, "totalBytes": strconv.FormatInt(total, 10), "sha256": wholeHash, "writeOutcome": "confirmed", "attachment": metadata, "created": true}
	commitInput := uploadservice.UploadInput{Action: "commit", TransferID: transferID, TotalBytes: strconv.FormatInt(total, 10), SHA256: wholeHash}
	uploads.expect(actor, project.ID, task.ID, commitInput, confirmed, nil, 1)
	ctx, cancel = context.WithTimeout(t.Context(), 15*time.Second)
	_, err = lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: commit})
	cancel()
	if err == nil || drop.commitDrops.Load() != 1 {
		t.Fatalf("commit response was not lost: %v", err)
	}
	uploads.expect(actor, project.ID, task.ID, statusInput, confirmed, nil, 1)
	recovered := object(call(client, status, false)["data"])
	if recovered["transferId"] != transferID || recovered["writeOutcome"] != "confirmed" || recovered["operationId"] != operationID || recovered["sha256"] != wholeHash || recovered["totalBytes"] != strconv.Itoa(len(all)) || recovered["attachment"] == nil {
		t.Fatalf("recovered status: %#v", recovered)
	}
	mcpAttachmentCheck(t, recovered, mcpUploadExpectedData(confirmed))
	uploads.expect(actor, project.ID, task.ID, commitInput, confirmed, &model.Fault{Code: "transfer_state_conflict", Message: "Transfer state does not permit this operation."}, 1)
	replayed := object(call(client, commit, true)["error"])
	refs := object(replayed["refs"])
	if replayed["writeOutcome"] != "confirmed" || refs["transferId"] != transferID || refs["operationId"] != recovered["operationId"] {
		t.Fatalf("replayed commit: %#v", replayed)
	}
	missing := args("status")
	missingID := uuid.NewString()
	missing["transferId"] = missingID
	uploads.expect(actor, project.ID, task.ID, uploadservice.UploadInput{Action: "status", TransferID: missingID}, nil, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound}, 1)
	if failure := object(call(client, missing, true)["error"]); failure["code"] != "not_found" {
		t.Fatalf("missing transfer: %#v", failure)
	}
	pendingID := uuid.NewString()
	pending := args("begin")
	pending["transferId"], pending["path"], pending["contentType"] = pendingID, "pending.bin", "application/octet-stream"
	pendingResult := map[string]any{"transferId": pendingID, "direction": "upload", "state": "receiving", "nextOffset": "0", "expiresAt": expiry, "cleanupState": "pending", "maxChunkBytes": 512 << 10}
	uploads.expect(actor, project.ID, task.ID, uploadservice.UploadInput{Action: "begin", TransferID: pendingID, Path: "pending.bin", ContentType: "application/octet-stream"}, pendingResult, nil, 1)
	pendingReceipt := object(call(client, pending, false)["data"])
	mcpAttachmentCheck(t, pendingReceipt, mcpUploadExpectedData(pendingResult))
	for _, action := range []string{"status", "abort", "chunk", "commit", "begin", "inline"} {
		input := args(action)
		expected := uploadservice.UploadInput{Action: action}
		switch action {
		case "status", "abort":
			input["transferId"] = pendingID
			expected.TransferID = pendingID
		case "chunk":
			chunkID := uuid.NewString()
			content := base64.StdEncoding.EncodeToString([]byte("x"))
			input["transferId"], input["chunkId"], input["offset"], input["contentBase64"] = pendingID, chunkID, "0", content
			expected.TransferID, expected.ChunkID, expected.Offset, expected.ContentBase64 = pendingID, chunkID, "0", content
		case "commit":
			input["transferId"], input["totalBytes"] = pendingID, "0"
			expected.TransferID, expected.TotalBytes = pendingID, "0"
		case "begin":
			id := uuid.NewString()
			input["transferId"], input["path"], input["contentType"] = id, "new.bin", "text/plain"
			expected.TransferID, expected.Path, expected.ContentType = id, "new.bin", "text/plain"
		case "inline":
			content := base64.StdEncoding.EncodeToString([]byte("x"))
			input["path"], input["contentType"], input["contentBase64"] = "new.bin", "text/plain", content
			expected.Path, expected.ContentType, expected.ContentBase64 = "new.bin", "text/plain", content
		}
		uploads.expect(actor, project.ID, task.ID, expected, nil, &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: model.ErrNotFound}, 1)
		if failure := object(call(client, input, true)["error"]); failure["code"] != "not_found" {
			t.Fatalf("deleted Project %s: %#v", action, failure)
		}
	}
}
