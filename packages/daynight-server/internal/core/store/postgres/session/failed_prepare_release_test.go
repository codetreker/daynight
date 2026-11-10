package session_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestFailedPreparationAndOriginalReleasePersistIndependentlyOfQuotaSettlement(t *testing.T) {
	db, id, actor := imageLedgerSession(t)
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	spec := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor.UserID, Fence: fence.Fence}, Name: "original.png", MediaType: "image/png", ByteLength: "8", SHA256: archiveHashOf("original")}
	encode := func(value any) json.RawMessage {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	prepare := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewSHA1(uuid.MustParse(spec.UploadID), []byte("prepare")).String(), Action: "prepare", Fence: fence, Body: encode(spec), Complete: true, Error: &sp.ImageError{Code: "budget_exceeded", Message: "Original preparation was rejected."}}
	receipt := sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "released", AcceptedOffset: "0"}
	release := store.SessionMediaRequest{SessionID: id, RequestID: uuid.NewSHA1(uuid.MustParse(spec.UploadID), []byte("release")).String(), Action: "release", Fence: fence, Body: encode(map[string]any{"uploadId": spec.UploadID, "spec": spec}), Complete: true, Result: encode(receipt)}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: spec, ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour), Receipt: sp.ImageUploadReceipt{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "released", AcceptedOffset: "0"}}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		if err := base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
			return err
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), prepare)
	})
	assertReserved := func(size int64) {
		t.Helper()
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			usage, err := base.(store.SessionResourceDAO).SessionResourceUsage(t.Context(), id)
			if err == nil && (usage.ReservedBytes != size || usage.ReservedResources != map[bool]int{true: 1}[size > 0]) {
				t.Fatal("quota did not follow committed storage release", usage, size)
			}
			return err
		})
	}
	assertReserved(8)
	rollback := errors.New("release transaction rolled back")
	_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), release); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		if _, err := base.(store.SessionMediaDAO).SessionMediaRequest(t.Context(), id, release.RequestID); !errors.Is(err, model.ErrNotFound) {
			t.Fatal("rollback published release", err)
		}
		return base.(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), release)
	})
	assertReserved(8)
	for _, replacement := range []store.SessionMediaRequest{
		{SessionID: id, RequestID: prepare.RequestID, Action: "prepare", Fence: fence, Body: encode(spec), Complete: true, Result: encode(receipt)},
		{SessionID: id, RequestID: release.RequestID, Action: "release", Fence: fence, Body: encode(map[string]any{"uploadId": spec.UploadID}), Complete: true, Result: encode(receipt)},
	} {
		_, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
			return scope.SessionDAO().(store.SessionMediaDAO).SaveSessionMediaRequest(t.Context(), replacement)
		})
		var conflict *model.Fault
		if !errors.As(err, &conflict) || conflict.Code != "resource_conflict" {
			t.Fatal("immutable original result or release body was replaced", err)
		}
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		media := base.(store.SessionMediaDAO)
		original, err := media.SessionMediaRequest(t.Context(), id, prepare.RequestID)
		if err != nil {
			return err
		}
		if !original.Complete || original.Result != nil || original.Error == nil || *original.Error != *prepare.Error {
			t.Fatal("release replaced definitive prepare failure", original)
		}
		confirmed, err := media.SessionMediaRequest(t.Context(), id, release.RequestID)
		if err != nil {
			return err
		}
		var body struct {
			UploadID string             `json:"uploadId"`
			Spec     sp.ImageUploadSpec `json:"spec"`
		}
		var got sp.LocalImagePreparation
		if !confirmed.Complete || confirmed.Error != nil || json.Unmarshal(confirmed.Body, &body) != nil || body.UploadID != spec.UploadID || body.Spec != spec || json.Unmarshal(confirmed.Result, &got) != nil || got != receipt {
			t.Fatal("release lost its exact original identity", confirmed)
		}
		return nil
	})
	upload.StorageReleased = true
	_, err = db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	assertReserved(8)
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload)
	})
	assertReserved(0)
}
