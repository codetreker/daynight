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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
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
	database := projectTestStore(t)
	files := attachmentTestFiles(t)
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	identityClient, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(config, database, database.Ready, files, identityClient)
	handler, err := New(app, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	production.Config.Handler = httpx.RequestLogging(logger, handler)
	production.Start()
	t.Cleanup(func() {
		production.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	principal, err := identityservice.New(database, identityClient, callback).Authenticate(t.Context(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	project, err := projectservice.NewProjects(database).Create(t.Context(), principal, projectcore.CreateProject{ExpectedUserID: principal.UserID, Name: "MCP upload", RepoURL: "host:mcp-upload-multichunk"})
	if err != nil {
		t.Fatal(err)
	}
	tasks := taskservice.NewTasks(database)
	task, err := tasks.Create(t.Context(), principal, project.ID, taskcore.CreateTask{Title: "MCP upload owner"})
	if err != nil {
		t.Fatal(err)
	}
	client := mcpPATClient(t, origin, token)
	drop := &dropUploadResponses{base: mcpPATTransport{token: token}}
	lossClient := sdk.NewClient(&sdk.Implementation{Name: "mcp-response-loss", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	lossSession, err := lossClient.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: origin + "/mcp", HTTPClient: &http.Client{Transport: drop}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lossSession.Close() })
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
	begin := args("begin")
	begin["transferId"], begin["path"], begin["contentType"] = transferID, "binary/combined.bin", "application/octet-stream"
	for i := int32(1); i <= 2; i++ {
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		_, err := lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: begin})
		cancel()
		if err == nil || drop.beginDrops.Load() != i {
			t.Fatalf("begin response %d was not lost: %v", i, err)
		}
		var active, matching int
		if err := database.Pool.QueryRow(t.Context(), `SELECT count(*), count(*) FILTER (WHERE id=$2 AND state='receiving') FROM private_transfers WHERE user_id=$1 AND state <> 'closed'`, principal.UserID, transferID).Scan(&active, &matching); err != nil || active != 1 || matching != 1 {
			t.Fatalf("lost begin %d did not preserve the original active transfer: active=%d matching=%d error=%v", i, active, matching, err)
		}
	}
	started := object(call(client, begin, false)["data"])
	if started["transferId"] != transferID || started["state"] != "receiving" || started["nextOffset"] != "0" {
		t.Fatalf("begin: %#v", started)
	}
	var active, matching int
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*), count(*) FILTER (WHERE id=$2) FROM private_transfers WHERE user_id=$1 AND state <> 'closed'`, principal.UserID, transferID).Scan(&active, &matching); err != nil || active != 1 || matching != 1 {
		t.Fatalf("repeated begin allocated extra active slots: active=%d matching=%d error=%v", active, matching, err)
	}
	parts := [][]byte{bytes.Repeat([]byte{0, 0xff, 0x7f, 0x41}, (512<<10)/4), bytes.Repeat([]byte{0x80, 0, 0xfe}, 171)}
	all := bytes.Join(parts, nil)
	offset := 0
	for _, part := range parts {
		chunk := args("chunk")
		digest := sha256.Sum256(part)
		chunk["transferId"], chunk["chunkId"], chunk["offset"] = transferID, uuid.NewString(), strconv.Itoa(offset)
		chunk["contentBase64"], chunk["sha256"] = base64.StdEncoding.EncodeToString(part), hex.EncodeToString(digest[:])
		receipt := object(call(client, chunk, false)["data"])
		offset += len(part)
		if receipt["receipt"] != "accepted" || receipt["sha256"] != chunk["sha256"] || receipt["nextOffset"] != strconv.Itoa(offset) {
			t.Fatalf("chunk: %#v", receipt)
		}
	}
	status := args("status")
	status["transferId"] = transferID
	before := object(call(client, status, false)["data"])
	if before["state"] != "receiving" || before["nextOffset"] != strconv.Itoa(len(all)) {
		t.Fatalf("before commit: %#v", before)
	}
	whole := sha256.Sum256(all)
	commit := args("commit")
	commit["transferId"], commit["totalBytes"], commit["sha256"] = transferID, strconv.Itoa(len(all)), hex.EncodeToString(whole[:])
	ctx, cancel = context.WithTimeout(t.Context(), 15*time.Second)
	_, err = lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: commit})
	cancel()
	if err == nil || drop.commitDrops.Load() != 1 {
		t.Fatalf("commit response was not lost: %v", err)
	}
	recovered := object(call(client, status, false)["data"])
	if recovered["transferId"] != transferID || recovered["writeOutcome"] != "confirmed" || recovered["operationId"] == nil || recovered["sha256"] != hex.EncodeToString(whole[:]) || recovered["totalBytes"] != strconv.Itoa(len(all)) || recovered["attachment"] == nil {
		t.Fatalf("recovered status: %#v", recovered)
	}
	replayed := object(call(client, commit, true)["error"])
	refs := object(replayed["refs"])
	if replayed["writeOutcome"] != "confirmed" || refs["transferId"] != transferID || refs["operationId"] != recovered["operationId"] {
		t.Fatalf("replayed commit: %#v", replayed)
	}
	attachments := attachmentservice.NewAttachments(database, database, files)
	metadata, opened, err := attachments.Open(t.Context(), principal, project.ID, task.ID, "binary/combined.bin")
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, all) || metadata.SizeBytes != int64(len(all)) || sha256.Sum256(got) != whole {
		t.Fatalf("uploaded bytes: len=%d metadata=%+v read=%v close=%v", len(got), metadata, readErr, closeErr)
	}
	after, err := tasks.Get(t.Context(), principal, project.ID, task.ID)
	if err != nil || after.Version != task.Version || !after.UpdatedAt.Equal(task.UpdatedAt) {
		t.Fatalf("task changed: %+v %v", after, err)
	}
	missing := args("status")
	missing["transferId"] = uuid.NewString()
	if failure := object(call(client, missing, true)["error"]); failure["code"] != "not_found" {
		t.Fatalf("missing transfer: %#v", failure)
	}
	pendingID := uuid.NewString()
	pending := args("begin")
	pending["transferId"], pending["path"], pending["contentType"] = pendingID, "pending.bin", "application/octet-stream"
	call(client, pending, false)
	if _, err = projectservice.NewProjects(database).Delete(t.Context(), principal, project.ID); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"status", "abort", "chunk", "commit", "begin", "inline"} {
		input := args(action)
		switch action {
		case "status", "abort":
			input["transferId"] = pendingID
		case "chunk":
			input["transferId"], input["chunkId"], input["offset"], input["contentBase64"] = pendingID, uuid.NewString(), "0", base64.StdEncoding.EncodeToString([]byte("x"))
		case "commit":
			input["transferId"], input["totalBytes"] = pendingID, "0"
		case "begin":
			input["transferId"], input["path"], input["contentType"] = uuid.NewString(), "new.bin", "text/plain"
		case "inline":
			input["path"], input["contentType"], input["contentBase64"] = "new.bin", "text/plain", base64.StdEncoding.EncodeToString([]byte("x"))
		}
		if failure := object(call(client, input, true)["error"]); failure["code"] != "not_found" {
			t.Fatalf("deleted Project %s: %#v", action, failure)
		}
	}
}
