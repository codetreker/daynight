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

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	database := newHTTPTestStore(t)
	principal := defaultHTTPPrincipal()
	token := defaultHTTPToken()
	files := attachmentTestFiles(t)
	production, _ := newMCPHTTPServer(t, database, files)
	origin := production.URL
	project := model.Project{ID: "e5555555-5555-4555-8555-555555555555"}
	task := model.Task{ID: "f6666666-6666-4666-8666-666666666666", ProjectID: project.ID, Title: "MCP upload owner", Version: 1}
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
	baseTime := time.Now().UTC()
	row := func(id, path string, version, offset, reserved, outstanding int64) model.PrivateTransfer {
		data := json.RawMessage(`{}`)
		if offset > 0 {
			data = json.RawMessage(fmt.Sprintf(`{"nextOffset":%d}`, offset))
		}
		return model.PrivateTransfer{ID: id, UserID: principal.UserID, AuthorityKind: "pat", AuthorityID: principal.CredentialID, Direction: "upload", ProjectID: project.ID, TaskID: task.ID, Path: path, ContentType: "application/octet-stream", Binding: json.RawMessage(`{}`), Data: data, State: "receiving", Version: version, ReservedBytes: reserved, OutstandingBytes: outstanding, CreatedAt: baseTime, UpdatedAt: baseTime, ExpiresAt: baseTime.Add(time.Hour), HardExpiresAt: baseTime.Add(24 * time.Hour)}
	}
	initial := row(transferID, "binary/combined.bin", 1, 0, 0, 0)
	dataOf := func(raw json.RawMessage) map[string]any {
		t.Helper()
		var data map[string]any
		if err := json.Unmarshal(raw, &data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	put := func(dao *mcpTransferDAO, before func() model.PrivateTransfer, after func() model.PrivateTransfer, check func(model.PrivateTransfer)) {
		t.Helper()
		counts := newHTTPCallPlan(t, map[string]int{"put": 1})
		dao.PutCall = func(ctx context.Context, input model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
			counts.Called("put")
			original := before()
			mcpAttachmentCheck(t, version, original.Version)
			mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.ProjectID, input.TaskID, input.Path, input.ContentType}, []string{original.ID, principal.UserID, "pat", principal.CredentialID, project.ID, task.ID, original.Path, "application/octet-stream"})
			if check != nil {
				check(input)
			}
			return mcpCloneFixture(after()), nil
		}
	}
	renew := func(before, after model.PrivateTransfer) *mcpTransferDAO {
		dao := mcpTransferRead(t, principal, 1, 0, mcpTransferRow(before), mcpTransferRow(before))
		put(dao, mcpTransferRow(before), mcpTransferRow(after), func(input model.PrivateTransfer) {
			mcpAttachmentCheck(t, input.State, "receiving")
			mcpAttachmentCheck(t, dataOf(input.Data), dataOf(before.Data))
			if input.ExpiresAt.Before(baseTime.Add(time.Hour)) {
				t.Errorf("permit did not renew expiry: %v", input.ExpiresAt)
			}
		})
		return dao
	}
	begin := args("begin")
	begin["transferId"], begin["path"], begin["contentType"] = transferID, "binary/combined.bin", "application/octet-stream"
	open := mcpTransferMissing(t, transferID)
	creation := newHTTPCallPlan(t, map[string]int{"authorize": 1, "insert": 1, "ledger": 1, "active": 1})
	open.AuthorizeCall = func(ctx context.Context, actor model.Principal, kind, id, pid, tid string) error {
		creation.Called("authorize")
		mcpAttachmentCheck(t, actor, principal)
		mcpAttachmentCheck(t, []string{kind, id, pid, tid}, []string{"pat", principal.CredentialID, project.ID, task.ID})
		return nil
	}
	open.InsertCall = func(ctx context.Context, input model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
		creation.Called("insert")
		mcpAttachmentCheck(t, []string{input.ID, input.UserID, input.AuthorityKind, input.AuthorityID, input.Direction, input.ProjectID, input.TaskID, input.Path, input.ContentType, input.State}, []string{transferID, principal.UserID, "pat", principal.CredentialID, "upload", project.ID, task.ID, "binary/combined.bin", "application/octet-stream", "receiving"})
		mcpAttachmentCheck(t, []int64{input.ReservedBytes, input.OutstandingBytes}, []int64{0, 0})
		mcpAttachmentCheck(t, dataOf(input.Data), map[string]any{})
		return mcpCloneFixture(initial), true, nil
	}
	open.LockLedgerCall = func(context.Context) error { creation.Called("ledger"); return nil }
	open.CountActiveCall = func(ctx context.Context, user string) (int, error) {
		creation.Called("active")
		mcpAttachmentCheck(t, user, principal.UserID)
		return 1, nil
	}
	for i := int32(1); i <= 2; i++ {
		if i == 1 {
			mcpTransferPlan(t, database, open)
		} else {
			mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, mcpTransferRow(initial)))
		}
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		_, err := lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: begin})
		cancel()
		if err == nil || drop.beginDrops.Load() != i {
			t.Fatalf("begin response %d was not lost: %v", i, err)
		}
	}
	mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, mcpTransferRow(initial)))
	started := object(call(client, begin, false)["data"])
	if started["transferId"] != transferID || started["state"] != "receiving" || started["nextOffset"] != "0" {
		t.Fatalf("begin: %#v", started)
	}
	parts := [][]byte{bytes.Repeat([]byte{0, 0xff, 0x7f, 0x41}, (512<<10)/4), bytes.Repeat([]byte{0x80, 0, 0xfe}, 171)}
	all := bytes.Join(parts, nil)
	offset := int64(0)
	receipts := make([]model.UploadChunk, 2)
	before := initial
	for index, part := range parts {
		chunk := args("chunk")
		chunkID := uuid.NewString()
		digest := sha256.Sum256(part)
		hash := hex.EncodeToString(digest[:])
		size := int64(len(part))
		chunk["transferId"], chunk["chunkId"], chunk["offset"] = transferID, chunkID, strconv.FormatInt(offset, 10)
		chunk["contentBase64"], chunk["sha256"] = base64.StdEncoding.EncodeToString(part), hash
		acquired := row(transferID, initial.Path, before.Version+1, offset, offset, 0)
		reserved := row(transferID, initial.Path, before.Version+2, offset, offset+size, size)
		materialized := row(transferID, initial.Path, before.Version+3, offset, offset+size, 0)
		accepted := row(transferID, initial.Path, before.Version+4, offset+size, offset+size, 0)
		prior := mcpTransferRead(t, principal, 0, 1, mcpTransferRow(acquired))
		priorCalls := newHTTPCallPlan(t, map[string]int{"receipt": 1})
		prior.UploadChunkCall = func(ctx context.Context, id, gotChunk string) (model.UploadChunk, error) {
			priorCalls.Called("receipt")
			mcpAttachmentCheck(t, []string{id, gotChunk}, []string{transferID, chunkID})
			return model.UploadChunk{}, model.ErrNotFound
		}
		reservation := mcpTransferRead(t, principal, 0, 1, mcpTransferRow(acquired), mcpTransferRow(acquired))
		reservationCalls := newHTTPCallPlan(t, map[string]int{"ledger": 2, "outstanding": 1, "reserved": 1, "add": 1})
		reservation.LockLedgerCall = func(context.Context) error { reservationCalls.Called("ledger"); return nil }
		reservation.OutstandingTotalCall = func(context.Context) (int64, error) { reservationCalls.Called("outstanding"); return 0, nil }
		reservation.ReservedTotalCall = func(context.Context) (int64, error) { reservationCalls.Called("reserved"); return offset, nil }
		reservation.AddReservationCall = func(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
			reservationCalls.Called("add")
			mcpAttachmentCheck(t, id, transferID)
			mcpAttachmentCheck(t, n, size)
			return mcpCloneFixture(reserved), nil
		}
		accept := mcpTransferRead(t, principal, 0, 1, mcpTransferRow(reserved), mcpTransferRow(reserved), mcpTransferRow(materialized))
		acceptCalls := newHTTPCallPlan(t, map[string]int{"insert receipt": 1, "ledger": 1, "consume": 1})
		accept.InsertUploadChunkCall = func(ctx context.Context, receipt model.UploadChunk) error {
			acceptCalls.Called("insert receipt")
			mcpAttachmentCheck(t, []string{receipt.TransferID, receipt.ChunkID, receipt.SHA256}, []string{transferID, chunkID, hash})
			mcpAttachmentCheck(t, []int64{receipt.Offset, receipt.Size}, []int64{offset, size})
			parsed, err := uuid.Parse(receipt.ObjectID)
			if err != nil || parsed.Version() != 4 {
				t.Errorf("invalid staged object ID: %s", receipt.ObjectID)
			}
			receipts[index] = receipt
			return nil
		}
		accept.LockLedgerCall = func(context.Context) error { acceptCalls.Called("ledger"); return nil }
		accept.SubtractOutstandingCall = func(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
			acceptCalls.Called("consume")
			mcpAttachmentCheck(t, id, transferID)
			mcpAttachmentCheck(t, n, size)
			return mcpCloneFixture(materialized), nil
		}
		put(accept, mcpTransferRow(materialized), mcpTransferRow(accepted), func(input model.PrivateTransfer) {
			mcpAttachmentCheck(t, input.State, "receiving")
			mcpAttachmentCheck(t, dataOf(input.Data), map[string]any{"nextOffset": float64(offset + size)})
		})
		mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, mcpTransferRow(before)), renew(before, acquired), mcpTransferRead(t, principal, 0, 0, mcpTransferRow(acquired)), prior, reservation, accept)
		receipt := object(call(client, chunk, false)["data"])
		offset += size
		if receipt["receipt"] != "accepted" || receipt["sha256"] != hash || receipt["nextOffset"] != strconv.FormatInt(offset, 10) {
			t.Fatalf("chunk: %#v", receipt)
		}
		before = accepted
	}
	status := args("status")
	status["transferId"] = transferID
	mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, mcpTransferRow(before)))
	observed := object(call(client, status, false)["data"])
	if observed["state"] != "receiving" || observed["nextOffset"] != strconv.Itoa(len(all)) {
		t.Fatalf("before commit: %#v", observed)
	}

	whole := sha256.Sum256(all)
	wholeHash := hex.EncodeToString(whole[:])
	total := int64(len(all))
	commit := args("commit")
	commit["transferId"], commit["totalBytes"], commit["sha256"] = transferID, strconv.FormatInt(total, 10), wholeHash
	acquired := row(transferID, initial.Path, before.Version+1, total, total, 0)
	reserved := row(transferID, initial.Path, before.Version+2, total, total*2, total)
	// Correlate the generated operation ID; progress and outcomes are supplied independently.
	operationID := ""
	metadata := model.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: initial.Path, ContentType: initial.ContentType, SizeBytes: total, CreatedAt: baseTime, UpdatedAt: baseTime}
	committedRow := func(version int64, state, outcome string) model.PrivateTransfer {
		value := row(transferID, initial.Path, version, total, total*2, total)
		value.State = state
		data := map[string]any{"nextOffset": total, "operationId": operationID, "totalBytes": total, "sha256": wholeHash, "writeOutcome": outcome}
		if outcome == "confirmed" {
			data["attachment"] = metadata
			data["created"] = true
		}
		raw, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		value.Data = raw
		if state == "committing" {
			deadline := baseTime.Add(time.Minute)
			value.LeaseUntil = &deadline
		}
		if state == "cleanup_pending" {
			previous := "committed"
			value.CleanupFromState = &previous
		}
		return value
	}
	committing := func() model.PrivateTransfer { return committedRow(reserved.Version+1, "committing", "unknown") }
	completed := func() model.PrivateTransfer { return committedRow(reserved.Version+2, "committed", "confirmed") }
	cleanup := func() model.PrivateTransfer { return committedRow(reserved.Version+3, "cleanup_pending", "confirmed") }
	chunkReader := func(receipt model.UploadChunk) *mcpTransferDAO {
		dao := mcpTransferRead(t, principal, 0, 0, mcpTransferRow(acquired))
		calls := newHTTPCallPlan(t, map[string]int{"read chunk": 1})
		dao.UploadChunkAtCall = func(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
			calls.Called("read chunk")
			mcpAttachmentCheck(t, id, transferID)
			mcpAttachmentCheck(t, offset, receipt.Offset)
			return receipt, nil
		}
		return dao
	}
	reservation := mcpTransferRead(t, principal, 0, 1, mcpTransferRow(acquired), mcpTransferRow(acquired))
	reservationCalls := newHTTPCallPlan(t, map[string]int{"ledger": 2, "outstanding": 1, "reserved": 1, "add": 1})
	reservation.LockLedgerCall = func(context.Context) error { reservationCalls.Called("ledger"); return nil }
	reservation.OutstandingTotalCall = func(context.Context) (int64, error) { reservationCalls.Called("outstanding"); return 0, nil }
	reservation.ReservedTotalCall = func(context.Context) (int64, error) { reservationCalls.Called("reserved"); return total, nil }
	reservation.AddReservationCall = func(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
		reservationCalls.Called("add")
		mcpAttachmentCheck(t, id, transferID)
		mcpAttachmentCheck(t, n, total)
		return mcpCloneFixture(reserved), nil
	}
	start := mcpTransferRead(t, principal, 0, 1, mcpTransferRow(reserved), mcpTransferRow(reserved))
	put(start, mcpTransferRow(reserved), committing, func(input model.PrivateTransfer) {
		mcpAttachmentCheck(t, input.State, "committing")
		data := dataOf(input.Data)
		id, ok := data["operationId"].(string)
		parsed, err := uuid.Parse(id)
		if !ok || err != nil || parsed.Version() != 4 || operationID != "" {
			t.Errorf("invalid commit operation identity: %s", id)
			panic("invalid commit operation identity")
		}
		operationID = id
		mcpAttachmentCheck(t, data, map[string]any{"nextOffset": float64(total), "operationId": id, "totalBytes": float64(total), "sha256": wholeHash, "writeOutcome": "unknown"})
		if input.LeaseUntil == nil || !input.LeaseUntil.After(baseTime) {
			t.Errorf("commit missing valid lease: %+v", input)
		}
	})
	finish := mcpTransferRead(t, principal, 0, 0, committing, committing)
	put(finish, committing, completed, func(input model.PrivateTransfer) {
		mcpAttachmentCheck(t, input.State, "committed")
		mcpAttachmentCheck(t, dataOf(input.Data), dataOf(completed().Data))
		mcpAttachmentCheck(t, input.LeaseUntil, (*time.Time)(nil))
	})
	clean := mcpTransferRead(t, principal, 0, 0, completed, completed)
	put(clean, completed, cleanup, func(input model.PrivateTransfer) {
		mcpAttachmentCheck(t, input.State, "cleanup_pending")
		mcpAttachmentCheck(t, dataOf(input.Data), dataOf(completed().Data))
		previous := "committed"
		mcpAttachmentCheck(t, input.CleanupFromState, &previous)
	})
	mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, mcpTransferRow(before)), renew(before, acquired), mcpTransferRead(t, principal, 0, 0, mcpTransferRow(acquired)), chunkReader(receipts[0]), chunkReader(receipts[1]), reservation, start, finish, clean)
	mutationCalls := newHTTPCallPlan(t, map[string]int{"mutation": 2, "presence": 2, "authorization": 1, "live": 1, "conflict": 2, "receipt": 2, "metadata": 1})
	expectedConflict := store.AttachmentConflictQuery{Ancestors: []string{"binary"}, DescendantPrefix: "binary/combined.bin/"}
	mutationDAO := &mcpAttachmentDAO{t: t, ConflictCall: func(ctx context.Context, pid, tid string, q store.AttachmentConflictQuery) (bool, error) {
		mutationCalls.Called("conflict")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project.ID, task.ID})
		mcpAttachmentCheck(t, q, expectedConflict)
		return false, nil
	}, PutCall: func(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
		mutationCalls.Called("metadata")
		mcpAttachmentCheck(t, input, model.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: initial.Path, ContentType: initial.ContentType, SizeBytes: total})
		return metadata, true, nil
	}}
	receiptIndex := 0
	scope := &mcpAttachmentScope{t: t, DAO: mutationDAO, PresenceCall: func(ctx context.Context, pid, tid string) (store.TaskPresence, error) {
		mutationCalls.Called("presence")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project.ID, task.ID})
		return store.TaskPresence{Found: true}, nil
	}, AuthorizationCall: func(ctx context.Context, actor model.Principal, pid string) (model.ProjectAccess, error) {
		mutationCalls.Called("authorization")
		mcpAttachmentCheck(t, actor, principal)
		mcpAttachmentCheck(t, pid, project.ID)
		return model.ProjectAccess{ProjectID: project.ID, UserID: principal.UserID, Role: model.ProjectAdmin}, nil
	}, LiveCall: func(ctx context.Context, pid string) error {
		mutationCalls.Called("live")
		mcpAttachmentCheck(t, pid, project.ID)
		return nil
	}, ChunkCall: func(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
		mutationCalls.Called("receipt")
		mcpAttachmentCheck(t, id, transferID)
		receipt := receipts[receiptIndex]
		receiptIndex++
		mcpAttachmentCheck(t, offset, receipt.Offset)
		return receipt, nil
	}}
	database.WriteAttachmentMutationCall = func(ctx context.Context, op func(store.AttachmentMutationScope) error) (store.Completion, error) {
		mutationCalls.Called("mutation")
		err := op(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	ctx, cancel = context.WithTimeout(t.Context(), 15*time.Second)
	_, err = lossSession.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: commit})
	cancel()
	if err == nil || drop.commitDrops.Load() != 1 {
		t.Fatalf("commit response was not lost: %v", err)
	}
	mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, cleanup))
	recovered := object(call(client, status, false)["data"])
	if recovered["transferId"] != transferID || recovered["writeOutcome"] != "confirmed" || recovered["operationId"] != operationID || recovered["sha256"] != wholeHash || recovered["totalBytes"] != strconv.Itoa(len(all)) || recovered["attachment"] == nil {
		t.Fatalf("recovered status: %#v", recovered)
	}
	mcpTransferPlan(t, database, mcpTransferRead(t, principal, 1, 0, cleanup))
	replayed := object(call(client, commit, true)["error"])
	refs := object(replayed["refs"])
	if replayed["writeOutcome"] != "confirmed" || refs["transferId"] != transferID || refs["operationId"] != recovered["operationId"] {
		t.Fatalf("replayed commit: %#v", replayed)
	}
	address, err := attachmentcore.NewAddress(project.ID, task.ID, "binary/combined.bin")
	if err != nil {
		t.Fatal(err)
	}
	opened, err := files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(opened.Body)
	closeErr := opened.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, all) || opened.Info.Size != total || sha256.Sum256(got) != whole {
		t.Fatalf("uploaded bytes: len=%d info=%+v read=%v close=%v", len(got), opened.Info, readErr, closeErr)
	}
	missing := args("status")
	missingID := uuid.NewString()
	missing["transferId"] = missingID
	mcpTransferPlan(t, database, mcpTransferMissing(t, missingID))
	if failure := object(call(client, missing, true)["error"]); failure["code"] != "not_found" {
		t.Fatalf("missing transfer: %#v", failure)
	}
	pendingID := uuid.NewString()
	pendingRow := row(pendingID, "pending.bin", 1, 0, 0, 0)
	pending := args("begin")
	pending["transferId"], pending["path"], pending["contentType"] = pendingID, "pending.bin", "application/octet-stream"
	pendingDAO := mcpTransferMissing(t, pendingID)
	pendingCalls := newHTTPCallPlan(t, map[string]int{"authorize": 1, "insert": 1, "ledger": 1, "active": 1})
	pendingDAO.AuthorizeCall = func(ctx context.Context, actor model.Principal, kind, id, pid, tid string) error {
		pendingCalls.Called("authorize")
		mcpAttachmentCheck(t, actor, principal)
		mcpAttachmentCheck(t, []string{kind, id, pid, tid}, []string{"pat", principal.CredentialID, project.ID, task.ID})
		return nil
	}
	pendingDAO.InsertCall = func(ctx context.Context, input model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
		pendingCalls.Called("insert")
		mcpAttachmentCheck(t, []string{input.ID, input.Path}, []string{pendingID, "pending.bin"})
		return mcpCloneFixture(pendingRow), true, nil
	}
	pendingDAO.LockLedgerCall = func(context.Context) error { pendingCalls.Called("ledger"); return nil }
	pendingDAO.CountActiveCall = func(ctx context.Context, user string) (int, error) {
		pendingCalls.Called("active")
		mcpAttachmentCheck(t, user, principal.UserID)
		return 2, nil
	}
	mcpTransferPlan(t, database, pendingDAO)
	call(client, pending, false)
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
		if action == "inline" {
			mcpAttachmentDenyRead(t, database, principal, project.ID)
			mcpAttachmentDenyMutation(t, database, principal, project.ID, task.ID)
		} else {
			var denied *mcpTransferDAO
			if action == "begin" {
				denied = mcpTransferMissing(t, input["transferId"].(string))
			} else {
				denied = mcpTransferRead(t, principal, 0, 0, mcpTransferRow(pendingRow))
			}
			deniedCalls := newHTTPCallPlan(t, map[string]int{"deny": 1})
			denied.AuthorizeCall = func(ctx context.Context, actor model.Principal, kind, id, pid, tid string) error {
				deniedCalls.Called("deny")
				mcpAttachmentCheck(t, actor, principal)
				mcpAttachmentCheck(t, []string{kind, id, pid, tid}, []string{"pat", principal.CredentialID, project.ID, task.ID})
				return model.ErrNotFound
			}
			mcpTransferPlan(t, database, denied)
		}
		if failure := object(call(client, input, true)["error"]); failure["code"] != "not_found" {
			t.Fatalf("deleted Project %s: %#v", action, failure)
		}
	}
}
