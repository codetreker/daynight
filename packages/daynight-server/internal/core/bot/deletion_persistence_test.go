package bot

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type deletionDAO struct {
	store.BotWriteDAO
	calls    int
	ctx      context.Context
	id       string
	deletion *model.BotDeletion
	result   model.Bot
	err      error
}

func (d *deletionDAO) SaveBotDeletion(ctx context.Context, id string, deletion *model.BotDeletion) (model.Bot, error) {
	d.calls++
	d.ctx, d.id, d.deletion = ctx, id, deletion
	return d.result, d.err
}

func TestSaveDeletionPersistsLockedStateAndReturnsResult(t *testing.T) {
	ctx := t.Context()
	input := model.Bot{ID: botID, Version: 4, Deletion: NewDeletion(store.DeleteBot{Version: 4, DeletionID: "delete"})}
	want := input
	want.Version++
	dao := &deletionDAO{result: want}
	got, err := SaveDeletion(ctx, dao, input)
	if err != nil || !reflect.DeepEqual(got, want) || dao.calls != 1 || dao.ctx != ctx || dao.id != input.ID || dao.deletion != input.Deletion {
		t.Fatalf("save = %+v, %v; DAO = %+v", got, err, dao)
	}
	boom := errors.New("save failed")
	dao = &deletionDAO{err: boom}
	if _, err := SaveDeletion(ctx, dao, input); err != boom || dao.calls != 1 {
		t.Fatalf("save failure = %v; calls = %d", err, dao.calls)
	}
	input.Version = math.MaxInt64
	dao = &deletionDAO{}
	got, err = SaveDeletion(ctx, dao, input)
	assertFault(t, err, "version_exhausted")
	if dao.calls != 0 || !reflect.DeepEqual(got, model.Bot{}) {
		t.Fatalf("exhausted version persisted: %+v, calls=%d", got, dao.calls)
	}
}

func TestReceiptDigestIncludesEveryReceiptByte(t *testing.T) {
	if got := ReceiptDigest([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("SHA-256 digest = %q", got)
	}
	if ReceiptDigest([]byte(`{"state":"completed","stopProof":"first"}`)) == ReceiptDigest([]byte(`{"state":"completed","stopProof":"second"}`)) {
		t.Fatal("changed stop proof retained its digest")
	}
}

func TestPrepareServerCleanupRequiresMatchingCompletedWorkerCleanup(t *testing.T) {
	for _, tc := range []struct {
		name     string
		deletion *model.BotDeletion
	}{
		{"missing deletion", nil},
		{"different deletion", &model.BotDeletion{DeletionID: "other", WorkerCleanup: model.BotCleanupResult{State: "completed"}}},
		{"pending worker", &model.BotDeletion{DeletionID: "delete", WorkerCleanup: model.BotCleanupResult{State: "pending"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			change, err := PrepareServerCleanup(model.Bot{Deletion: tc.deletion}, "delete")
			assertFault(t, err, "session_conflict")
			if change {
				t.Fatal("invalid cleanup was admitted")
			}
		})
	}
}
