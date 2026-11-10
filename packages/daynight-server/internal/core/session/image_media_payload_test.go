package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mediaOutsideTransactionStorage struct {
	filestorage.Storage
	inTransaction *bool
	t             *testing.T
}

func (s mediaOutsideTransactionStorage) Open(ctx context.Context, b, p string) (filestorage.Object, error) {
	s.t.Helper()
	if *s.inTransaction {
		s.t.Fatal("file open inside database transaction")
	}
	return s.Storage.Open(ctx, b, p)
}
func (s mediaOutsideTransactionStorage) Put(ctx context.Context, b, p string, r io.Reader) (filestorage.FileInfo, error) {
	s.t.Helper()
	if *s.inTransaction {
		s.t.Fatal("file publication inside database transaction")
	}
	return s.Storage.Put(ctx, b, p, r)
}
func (s mediaOutsideTransactionStorage) AcquireGate(ctx context.Context, d filestorage.GateDomain, k string) (io.Closer, error) {
	s.t.Helper()
	if *s.inTransaction {
		s.t.Fatal("file gate wait inside database transaction")
	}
	return s.Storage.AcquireGate(ctx, d, k)
}

func mediaPayloadAccess(f imageRuleFixture, inTransaction *bool) imageStorageAccess {
	return func(ctx context.Context, work func(*operationTx, *record) error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		*inTransaction = true
		defer func() { *inTransaction = false }()
		return work(&operationTx{dao: f.d, op: &Operation{}}, f.r)
	}
}
func mediaRelay(t *testing.T, f imageRuleFixture) (*Execution, imageStorageAccess) {
	t.Helper()
	active := false
	files := mediaOutsideTransactionStorage{Storage: f.files, inTransaction: &active, t: t}
	relay := &Execution{Engine: NewEngine(files)}
	access := mediaPayloadAccess(f, &active)
	relay.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
		if fence != f.r.Snapshot.ControllerFence {
			return conflict()
		}
		return access(ctx, func(tx *operationTx, r *record) error { return work(&Access{tx: tx, record: r, write: true}) })
	}
	return relay, access
}
func readMediaFixture(t *testing.T, action string) (imageRuleFixture, store.SessionMediaRequest, sp.ControllerMessage) {
	t.Helper()
	raw := []byte("shared original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	body := map[string]any{"attemptId": f.spec.UploadID, "captureId": uuid.NewString(), "sha256": f.spec.SHA256, "byteLength": f.spec.ByteLength, "offset": "0", "limit": imageChunkBytes}
	if action == "read_prepared" {
		body = map[string]any{"preparationId": f.spec.UploadID, "offset": "0", "limit": imageChunkBytes}
	}
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: action, Fence: f.r.Snapshot.ControllerFence, Body: encode(body)}
	f.d.media[row.RequestID] = row
	result := encode(sp.PreparedImageChunk{PreparationID: f.spec.UploadID, SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
	return f, row, sp.ControllerMessage{Type: "image_response", ControllerFence: row.Fence, RequestID: row.RequestID, Action: action, MediaResult: result}
}

func TestMediaWriteReplaysAcrossInstancesWithoutDatabaseOriginal(t *testing.T) {
	raw := []byte("shared original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	wire := encode(sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)})
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: mediaIdentity(f.spec.UploadID, "write/0"), Action: "write", Fence: f.r.Snapshot.ControllerFence, Body: wire}
	f.d.media[row.RequestID] = row // A legacy full-body pending request.
	relay, access := mediaRelay(t, f)
	var offers []map[string]any
	if err := access(t.Context(), func(tx *operationTx, r *record) error {
		var err error
		offers, err = relay.mediaOffers(t.Context(), tx, r)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(f.d.media[row.RequestID].Body, []byte(`"data"`)) || f.d.media[row.RequestID].Complete {
		t.Fatal("normalization retained original bytes or changed pending outcome")
	}
	offers, err := relay.hydrateMediaOffers(t.Context(), row.Fence, offers)
	if err != nil || len(offers) != 1 || !jsonEqual(offers[0]["body"].(json.RawMessage), wire) {
		t.Fatal("relay did not reconstruct original immutable bytes", offers, err)
	}
	// An independent relay instance needs neither a caller mailbox nor affinity.
	other, _ := mediaRelay(t, f)
	if _, err = other.hydrateMediaOffers(t.Context(), row.Fence, offers); err != nil {
		t.Fatal(err)
	}
	path := f.d.chunks[f.spec.UploadID][0].Path
	if err = f.files.Delete(t.Context(), sessionresource.Bucket, path); err != nil {
		t.Fatal(err)
	}
	offers[0]["body"] = json.RawMessage(f.d.media[row.RequestID].Body)
	if _, err = other.hydrateMediaOffers(t.Context(), row.Fence, offers); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("missing chunk was offered under the original identity", err)
	}
	if f.d.uploads[f.spec.UploadID].StorageReleased || f.d.media[row.RequestID].Complete {
		t.Fatal("missing bytes settled an unknown outcome")
	}
}

func TestMediaReadReceiptPersistsOnlyMetadataAndRecoversOnAnotherInstance(t *testing.T) {
	for _, action := range []string{"read_capture", "read_prepared"} {
		t.Run(action, func(t *testing.T) {
			f, row, message := readMediaFixture(t, action)
			relay, access := mediaRelay(t, f)
			prepared, check, finish, err := relay.prepareReadMediaResponse(t.Context(), message)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(prepared.MediaResult, []byte(`"data"`)) {
				t.Fatal("prepared receipt still contains original")
			}
			if err = access(t.Context(), func(tx *operationTx, r *record) error {
				if err := check(tx, r); err != nil {
					return err
				}
				_, err := relay.acceptMediaResponse(t.Context(), tx, r, prepared)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err = finish(); err != nil {
				t.Fatal(err)
			}
			// Treat the transport result as lost after the durable metadata proposal.
			// A fresh instance observes that exact original request, not a new identity.
			observer, observe := mediaRelay(t, f)
			var body any
			_ = json.Unmarshal(row.Body, &body)
			raw, err := observer.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, observe)
			if err != nil || !jsonEqual(raw, message.MediaResult) {
				t.Fatal("new instance lost original receipt bytes", string(raw), err)
			}
			saved := f.d.media[row.RequestID]
			if !saved.Complete || bytes.Contains(saved.Result, []byte(`"data"`)) || !jsonEqual(saved.Body, row.Body) || len(f.d.media) != 1 || len(f.d.leases) != 0 {
				t.Fatal("read recovery retained raw bytes, changed identity or leaked leases")
			}
			// Completed receipts preserve their original connection epoch;
			// browser recovery uses a fresh admission fence around file I/O.
			f.r.Snapshot.ConnectionEpoch = "2"
			raw, err = observer.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, observe)
			if err != nil || !jsonEqual(raw, message.MediaResult) {
				t.Fatal("completed receipt was lost across reconnect", err)
			}
			// The already-published response is the exact chunk reused by ordinary copy.
			data, _ := base64.StdEncoding.DecodeString("c2hhcmVkIG9yaWdpbmFs")
			if _, err = f.write(t, data, 0); err != nil {
				t.Fatal(err)
			}
			if _, err = f.complete(t); err != nil {
				t.Fatal(err)
			}
			raw, err = observer.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, observe)
			if err != nil || !jsonEqual(raw, message.MediaResult) {
				t.Fatal("staging cleanup lost completed blob replay", err)
			}
			changed := message
			var result sp.PreparedImageChunk
			_ = json.Unmarshal(message.MediaResult, &result)
			result.Data = base64.StdEncoding.EncodeToString([]byte("other original!"))
			changed.MediaResult = encode(result)
			if _, _, _, err = relay.prepareReadMediaResponse(t.Context(), changed); err == nil {
				t.Fatal("completed receipt accepted changed original bytes")
			}
		})
	}
}

func TestMediaReadPublicationFailureAndCancellationRetainOriginalIdentity(t *testing.T) {
	for _, point := range []string{"cancelled", "changed epoch", "changed result", "corrupt chunk"} {
		t.Run(point, func(t *testing.T) {
			f, row, message := readMediaFixture(t, "read_capture")
			relay, access := mediaRelay(t, f)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			prepared, check, finish, err := relay.prepareReadMediaResponse(ctx, message)
			if err != nil {
				t.Fatal(err)
			}
			switch point {
			case "cancelled":
				cancel()
			case "changed epoch":
				f.r.Snapshot.ConnectionEpoch = "2"
			case "changed result":
				old := f.d.media[row.RequestID]
				old.Complete = true
				old.Result = []byte(`{"original":"different"}`)
				f.d.media[row.RequestID] = old
			case "corrupt chunk":
				n, _ := sessionresource.NewNamespace("", f.p.UserID, row.SessionID)
				path, _ := n.ChunkPath(f.spec.UploadID, 0)
				if _, err = f.files.Put(t.Context(), sessionresource.Bucket, path, bytes.NewReader([]byte("corrupt"))); err != nil {
					t.Fatal(err)
				}
			}
			err = access(ctx, func(tx *operationTx, r *record) error {
				if err := check(tx, r); err != nil {
					return err
				}
				_, err := relay.acceptMediaResponse(ctx, tx, r, prepared)
				return err
			})
			if point == "corrupt chunk" {
				// Publication succeeded before corruption; a later observer must verify
				// the persisted digest rather than return that changed content.
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("changed or cancelled publication became a receipt")
			}
			_ = finish()
			if f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("failed response returned reservation")
			}
			if point == "corrupt chunk" {
				var body any
				_ = json.Unmarshal(row.Body, &body)
				if _, err = relay.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, access); err == nil {
					t.Fatal("corrupt persisted bytes were returned")
				}
			}
		})
	}
}

func TestMediaResourceReadUsesExistingOriginalWithoutExtraPublication(t *testing.T) {
	f, saved := completedReclaimFixture(t)
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "read", Fence: f.r.Snapshot.ControllerFence, Body: encode(sp.ImageReadRequest{ResourceID: saved.Resource.ResourceID, Offset: "0", Limit: imageChunkBytes})}
	f.d.media[row.RequestID] = row
	raw := []byte("original")
	message := sp.ControllerMessage{Type: "image_response", ControllerFence: row.Fence, RequestID: row.RequestID, Action: "read", MediaResult: encode(sp.ImageReadChunk{ResourceID: saved.Resource.ResourceID, SHA256: *saved.Resource.SHA256, ByteLength: *saved.Resource.ByteLength, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})}
	relay, access := mediaRelay(t, f)
	prepared, check, finish, err := relay.prepareReadMediaResponse(t.Context(), message)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	if err = access(t.Context(), func(tx *operationTx, r *record) error {
		if err := check(tx, r); err != nil {
			return err
		}
		_, err := relay.acceptMediaResponse(t.Context(), tx, r, prepared)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var body any
	_ = json.Unmarshal(row.Body, &body)
	result, err := relay.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, access)
	if err != nil || !jsonEqual(result, message.MediaResult) {
		t.Fatal("resource replay did not use existing metered original", err)
	}
}

func TestMediaPayloadAdmissionRejectsUnsafeRangesAndMissingOwners(t *testing.T) {
	for _, kind := range []string{"missing capability", "media lookup", "wrong identity", "invalid digest", "missing digest", "invalid range", "invalid namespace", "missing upload", "closed upload", "past end", "wrong attempt", "ahead of accepted", "changed capture hash", "usage failure", "frozen", "lease failure", "missing chunk", "changed chunk hash", "missing resource", "unavailable resource", "missing descriptor", "wrong blob path"} {
		t.Run(kind, func(t *testing.T) {
			f, row, message := readMediaFixture(t, "read_capture")
			payload, _, err := compactMediaPayload(message.MediaResult, true)
			if err != nil {
				t.Fatal(err)
			}
			d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("media plan dependency unavailable")}
			var dao store.SessionDAO = d
			switch kind {
			case "missing capability":
				dao = &mediaStorageRuleDAO{}
			case "media lookup":
				dao = &mediaFailureDAO{imageRuleDAO: f.d, point: "read", cause: d.cause}
			case "wrong identity":
				row.Fence.ConnectionEpoch = "2"
			case "invalid digest":
				payload = []byte(`{"$data":{"sha256":"bad","byteLength":8}}`)
			case "missing digest":
				payload = []byte(`{}`)
			case "invalid range":
				var body map[string]any
				_ = json.Unmarshal(row.Body, &body)
				body["offset"] = "00"
				row.Body = encode(body)
			case "invalid namespace":
				f.r.Snapshot.Identity.ProjectID = "../project"
			case "missing upload":
				delete(f.d.uploads, f.spec.UploadID)
			case "closed upload":
				upload := f.d.uploads[f.spec.UploadID]
				upload.Receipt.State = "released"
				f.d.uploads[f.spec.UploadID] = upload
			case "past end":
				upload := f.d.uploads[f.spec.UploadID]
				upload.Spec.ByteLength = "1"
				f.d.uploads[f.spec.UploadID] = upload
			case "wrong attempt":
				var fields map[string]any
				_ = json.Unmarshal(payload, &fields)
				fields["preparationId"] = uuid.NewString()
				payload = encode(fields)
			case "ahead of accepted":
				var body map[string]any
				_ = json.Unmarshal(row.Body, &body)
				body["offset"] = "1"
				row.Body = encode(body)
				var fields map[string]any
				_ = json.Unmarshal(payload, &fields)
				fields["offset"] = "1"
				fields["byteLength"] = "16"
				payload = encode(fields)
				upload := f.d.uploads[f.spec.UploadID]
				upload.Spec.ByteLength = "16"
				f.d.uploads[f.spec.UploadID] = upload
			case "changed capture hash":
				var body map[string]any
				_ = json.Unmarshal(row.Body, &body)
				body["sha256"] = imageBytesHash([]byte("different"))
				row.Body = encode(body)
			case "usage failure":
				d.point = "usage"
			case "frozen":
				f.d.usage.Frozen = true
			case "lease failure":
				d.point = "lease"
			case "missing chunk", "changed chunk hash":
				row.Action = "write"
				wire := encode(sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: f.spec.SHA256, Data: base64.StdEncoding.EncodeToString([]byte("shared original"))})
				row.Body, _, _ = compactMediaPayload(wire, true)
				payload = row.Body
				if kind == "changed chunk hash" {
					var fields map[string]any
					_ = json.Unmarshal(row.Body, &fields)
					fields["sha256"] = imageBytesHash([]byte("different"))
					row.Body = encode(fields)
					payload = row.Body
				}
			case "missing resource", "unavailable resource", "missing descriptor", "wrong blob path":
				row.Action = "read"
				resourceID := uuid.NewString()
				row.Body = encode(sp.ImageReadRequest{ResourceID: resourceID, Offset: "0", Limit: imageChunkBytes})
				var fields map[string]any
				_ = json.Unmarshal(payload, &fields)
				delete(fields, "preparationId")
				fields["resourceId"] = resourceID
				payload = encode(fields)
				if kind != "missing resource" {
					size, digest := "15", f.spec.SHA256
					n, _ := sessionresource.NewNamespace("", f.p.UserID, row.SessionID)
					path, _ := n.BlobPath(resourceID)
					saved := store.SessionResourceRecord{SessionID: row.SessionID, BlobID: resourceID, BlobPath: path, Resource: sp.Resource{Status: "available", ByteLength: &size, SHA256: &digest}}
					if kind == "unavailable resource" {
						saved.GCPending = true
					}
					if kind == "missing descriptor" {
						saved.Resource.SHA256 = nil
					}
					if kind == "wrong blob path" {
						saved.BlobPath = "another/path"
					}
					f.d.resources[resourceID] = saved
				}
			}
			if kind != "wrong identity" {
				f.d.media[row.RequestID] = row
			}
			_, err = f.s.planMediaFile(t.Context(), &operationTx{dao: dao}, f.r, row, payload, false, uuid.NewString())
			if err == nil {
				t.Fatal("unsafe payload owner or range admitted", kind)
			}
			if f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("failed admission returned storage reservation")
			}
		})
	}
}

type mediaSettlementFailureDAO struct {
	*imageRuleDAO
	cause error
}

func (d mediaSettlementFailureDAO) SessionUploadMediaRequests(context.Context, string, string, string) ([]store.SessionMediaRequest, error) {
	return nil, d.cause
}
func TestMediaPayloadSettlementScrubsLegacyTerminalCopiesWithObservedCAS(t *testing.T) {
	f, row, message := readMediaFixture(t, "read_capture")
	row.Complete, row.Result = true, message.MediaResult
	f.d.media[row.RequestID] = row
	if err := settleUploadMedia(t.Context(), &operationTx{dao: f.d}, row.SessionID, f.spec.UploadID, f.d.uploads[f.spec.UploadID].BlobID); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(f.d.media[row.RequestID].Result, []byte(`"data"`)) || !f.d.media[row.RequestID].Complete {
		t.Fatal("terminal cleanup retained database original or lost receipt")
	}
	cause := errors.New("upload media inventory unavailable")
	if err := settleUploadMedia(t.Context(), &operationTx{dao: mediaSettlementFailureDAO{imageRuleDAO: f.d, cause: cause}}, row.SessionID, f.spec.UploadID, ""); !errors.Is(err, cause) {
		t.Fatal(err)
	}
	if err := settleUploadMedia(t.Context(), &operationTx{dao: &mediaStorageRuleDAO{}}, row.SessionID, f.spec.UploadID, ""); err == nil {
		t.Fatal("missing settlement capability accepted")
	}
	legacy := row
	legacy.Action = "write"
	legacy.Body = []byte(`{"uploadId":"` + f.spec.UploadID + `","data":7}`)
	legacy.Result = nil
	legacy.Complete = false
	f.d.media[row.RequestID] = legacy
	if err := settleUploadMedia(t.Context(), &operationTx{dao: f.d}, row.SessionID, f.spec.UploadID, ""); err == nil {
		t.Fatal("malformed legacy payload silently dropped")
	}
}

func TestMediaPayloadMetadataRejectsAmbiguousAndOversizedOriginals(t *testing.T) {
	for _, raw := range [][]byte{[]byte(`{`), []byte(`{"data":"b3JpZ2luYWw=","$data":{}}`), []byte(`{"data":false}`), []byte(`{"data":"*"}`), encode(map[string]string{"data": base64.StdEncoding.EncodeToString(make([]byte, imageChunkBytes+1))})} {
		if _, _, err := compactMediaPayload(raw, true); err == nil {
			t.Fatal("invalid original was compacted")
		}
	}
	for _, raw := range []string{`{`, `{"$data":false}`, `{"$data":{"sha256":"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","byteLength":1}}`} {
		if _, _, err := mediaPayloadIdentity([]byte(raw)); err == nil {
			t.Fatal("invalid digest metadata accepted")
		}
	}
	if err := validateReadMediaMetadata("read", "id", "hash", "8", "0", 8, []byte(`{`), 8); err == nil {
		t.Fatal("malformed range accepted")
	}
	f, row, message := readMediaFixture(t, "read_capture")
	relay, _ := mediaRelay(t, f)
	for _, mutate := range []func(*sp.ControllerMessage){func(m *sp.ControllerMessage) { m.Type = "heartbeat" }, func(m *sp.ControllerMessage) { m.MediaError = &sp.ImageError{Code: "unavailable"} }, func(m *sp.ControllerMessage) { m.MediaResult = []byte(`{}`) }} {
		candidate := message
		mutate(&candidate)
		if _, _, finish, err := relay.prepareReadMediaResponse(t.Context(), candidate); err != nil || finish != nil {
			t.Fatal("non-payload response started file work", err)
		}
	}
	message.RequestID = uuid.NewString()
	if _, _, finish, err := relay.prepareReadMediaResponse(t.Context(), message); err != nil || finish != nil {
		t.Fatal("unknown identity created a payload owner", err)
	}
	message.RequestID = row.RequestID
	message.Action = "read_prepared"
	if _, _, _, err := relay.prepareReadMediaResponse(t.Context(), message); err == nil {
		t.Fatal("changed response action created a payload owner")
	}
}

func TestMediaFileFinalRecheckRejectsChangedOwnerAndDependencyFailures(t *testing.T) {
	for _, kind := range []string{"missing capability", "usage failure", "delete epoch", "media lookup", "identity body", "upload lookup", "upload state", "blob identity"} {
		t.Run(kind, func(t *testing.T) {
			f, row, message := readMediaFixture(t, "read_capture")
			payload, _, err := compactMediaPayload(message.MediaResult, true)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := f.s.planMediaFile(t.Context(), &operationTx{dao: f.d}, f.r, row, payload, false, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			for _, lease := range f.d.leases {
				if lease.ResourceID != "" {
					t.Fatal("unpublished upload acquired a nonexistent resource lease")
				}
			}
			d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("final dependency unavailable")}
			var dao store.SessionDAO = d
			switch kind {
			case "missing capability":
				dao = &mediaStorageRuleDAO{}
			case "usage failure":
				d.point = "usage"
			case "delete epoch":
				f.d.usage.DeleteEpoch++
			case "media lookup":
				dao = &mediaFailureDAO{imageRuleDAO: f.d, point: "read", cause: d.cause}
			case "identity body":
				current := f.d.media[row.RequestID]
				current.Body = []byte(`{}`)
				f.d.media[row.RequestID] = current
			case "upload lookup":
				d.point = "upload"
			case "upload state":
				upload := f.d.uploads[f.spec.UploadID]
				upload.Receipt.State = "complete"
				f.d.uploads[f.spec.UploadID] = upload
			case "blob identity":
				upload := f.d.uploads[f.spec.UploadID]
				upload.BlobID = uuid.NewString()
				f.d.uploads[f.spec.UploadID] = upload
			}
			if err = f.s.recheckMediaFile(t.Context(), &operationTx{dao: dao}, f.r, plan); err == nil {
				t.Fatal("final recheck published changed state", kind)
			}
		})
	}
}

func TestMediaReadUnknownCompletionReconcilesOriginalSharedChunk(t *testing.T) {
	for _, persisted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unobserved proposal", true: "observed original receipt"}[persisted], func(t *testing.T) {
			f, row, message := readMediaFixture(t, "read_capture")
			relay, access := mediaRelay(t, f)
			prepared, check, finish, err := relay.prepareReadMediaResponse(t.Context(), message)
			if err != nil {
				t.Fatal(err)
			}
			lost := errors.New("commit acknowledgement lost")
			// Supply a lower completion outcome independently of callback
			// success. Both possible durable observations keep the same ID.
			completeUnknown := func() error {
				err := access(t.Context(), func(tx *operationTx, r *record) error {
					if err := check(tx, r); err != nil {
						return err
					}
					_, err := relay.acceptMediaResponse(t.Context(), tx, r, prepared)
					return err
				})
				if err != nil {
					return err
				}
				if !persisted {
					f.d.media[row.RequestID] = row
				}
				return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: lost}
			}
			err = completeUnknown()
			var unknown *store.TransactionError
			if !errors.As(err, &unknown) || unknown.Outcome != store.TransactionUnknown || !errors.Is(err, lost) {
				t.Fatal("unknown completion was hidden", err)
			}
			if err = finish(); err != nil {
				t.Fatal(err)
			}
			peer, peerAccess := mediaRelay(t, f)
			prepared, check, finish, err = peer.prepareReadMediaResponse(t.Context(), message)
			if err != nil {
				t.Fatal("original identity could not reconcile after unknown", err)
			}
			err = peerAccess(t.Context(), func(tx *operationTx, r *record) error {
				if err := check(tx, r); err != nil {
					return err
				}
				_, err := peer.acceptMediaResponse(t.Context(), tx, r, prepared)
				return err
			})
			err = errors.Join(err, finish())
			if err != nil {
				t.Fatal(err)
			}
			var body any
			_ = json.Unmarshal(row.Body, &body)
			out, err := peer.controllerMediaWithAccess(t.Context(), row.SessionID, row.RequestID, row.Action, body, peerAccess)
			if err != nil || !jsonEqual(out, message.MediaResult) || len(f.d.media) != 1 || f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("unknown replay changed identity, lost bytes or released quota", err)
			}
		})
	}
}
