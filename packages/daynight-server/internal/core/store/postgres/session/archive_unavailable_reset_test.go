package session_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveResetRetainsUnavailableResourceAndReusesItsUniqueRow(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	reason := "Original bytes were never captured."
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy-missing", Error: &reason}
	raw, e := json.Marshal(descriptor)
	if e != nil {
		t.Fatal(e)
	}
	refs, e := json.Marshal([]sp.ArchiveResourceReference{{Resource: descriptor}})
	if e != nil {
		t.Fatal(e)
	}
	ledger, e := json.Marshal(map[string]any{"HistoryEpoch": "original-history", "SourceThrough": "7", "Sealable": true, "Resources": []sp.Resource{descriptor}, "Entries": []any{}})
	if e != nil {
		t.Fatal(e)
	}
	fileID := uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "failed", Revision: 1, Identity: json.RawMessage(`{"controller":"original"}`), Resources: refs, Ledger: ledger, TimelineID: fileID}
	original := store.SessionResourceRecord{SessionID: id, Resource: descriptor}
	reference := store.SessionResourceReference{SessionID: id, ResourceID: descriptor.ResourceID, Kind: "archive", ReferenceID: bundle.PrepareID}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
		if e := media.InsertSessionResource(ctx, original); e != nil {
			return e
		}
		if e := media.AddSessionResourceReference(ctx, reference); e != nil {
			return e
		}
		if e := archive.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		return archive.SaveSessionArchiveFile(ctx, store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "timeline", SHA256: archiveHashOf("invalid timeline"), ByteLength: 16, AcceptedOffset: 16, State: "failed", Path: "original/timeline", TimelineRevision: 1})
	})
	reset := bundle
	reset.Revision, reset.Phase, reset.TimelineID, reset.Resources = 2, "settling", "", json.RawMessage(`[]`)
	rejected := errors.New("reject reset transaction")
	for _, attempt := range []string{"rollback", "commit"} {
		completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
			base := scope.SessionDAO()
			if _, e := base.LockSession(ctx, id); e != nil {
				return e
			}
			archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
			if _, e := archive.SessionArchiveBundle(ctx, id); e != nil {
				return e
			}
			if e := media.RemoveSessionResourceReference(ctx, reference); e != nil {
				return e
			}
			if e := archive.SaveSessionArchiveBundle(ctx, reset); e != nil {
				return e
			}
			if attempt == "rollback" {
				return rejected
			}
			return nil
		})
		if attempt == "rollback" {
			if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
				t.Fatal(completion, e)
			}
		} else if completion.Outcome != store.TransactionCommitted || e != nil {
			t.Fatal(completion, e)
		}
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
			saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
			if e != nil {
				return e
			}
			if !reflect.DeepEqual(saved, original) {
				t.Fatal("reset changed retained unavailable identity", saved)
			}
			stored, e := archive.SessionArchiveBundle(ctx, id)
			if e != nil {
				return e
			}
			var storedLedger any
			if json.Unmarshal(stored.Ledger, &storedLedger) != nil {
				t.Fatal("nonempty ledger lost")
			}
			var expectedLedger any
			_ = json.Unmarshal(ledger, &expectedLedger)
			if !reflect.DeepEqual(storedLedger, expectedLedger) {
				t.Fatal("reset changed unavailable ledger", storedLedger)
			}
			pins, e := media.SessionResourceReferenceCount(ctx, id, descriptor.ResourceID)
			if e != nil {
				return e
			}
			if attempt == "rollback" {
				if stored.Phase != "failed" || stored.Revision != 1 || pins != 1 {
					t.Fatal("reset partially committed", stored, pins)
				}
			} else if stored.Phase != "settling" || stored.Revision != 2 || pins != 0 {
				t.Fatal("reset candidate not durable", stored, pins)
			}
			return nil
		})
	}
	// A reset removes its pin, not the original row: an accidental second INSERT
	// must still fail through PostgreSQL's real primary key.
	completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).InsertSessionResource(ctx, original)
	})
	var conflict *model.Fault
	if e == nil || completion.Outcome != store.TransactionNotCommitted || !errors.As(e, &conflict) || conflict.Code != "resource_conflict" {
		t.Fatal("duplicate original row did not retain real uniqueness", completion, e)
	}
	resealed := reset
	resealed.Phase, resealed.Resources = "sealed", refs
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		media, archive := base.(store.SessionResourceDAO), base.(store.SessionArchiveDAO)
		saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(saved, original) {
			t.Fatal("reused unavailable resource changed")
		}
		if e = media.AddSessionResourceReference(ctx, reference); e != nil {
			return e
		}
		return archive.SaveSessionArchiveBundle(ctx, resealed)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		media, archive := base.(store.SessionResourceDAO), base.(store.SessionArchiveDAO)
		saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		stored, e := archive.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		pins, e := media.SessionResourceReferenceCount(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(saved, original) || stored.Phase != "sealed" || stored.Revision != 2 || pins != 1 {
			t.Fatal("reseal candidate failed persisted readback", saved, stored, pins)
		}
		var persisted []sp.ArchiveResourceReference
		if json.Unmarshal(stored.Resources, &persisted) != nil || len(persisted) != 1 || !reflect.DeepEqual(persisted[0].Resource, descriptor) || persisted[0].BlobID != nil {
			t.Fatal("unavailable closure changed", persisted)
		}
		return nil
	})
	var count int
	if e = database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_resources WHERE session_id=$1 AND resource_id=$2 AND descriptor=$3::jsonb AND content IS NULL AND blob_id IS NULL AND blob_path IS NULL`, id, descriptor.ResourceID, raw).Scan(&count); e != nil || count != 1 {
		t.Fatal("unique unavailable row was not retained", count, e)
	}
}

func TestArchiveUnavailableInlinePresenceIsMetadataOnly(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy-missing"}
	raw, e := json.Marshal(descriptor)
	if e != nil {
		t.Fatal(e)
	}
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,$3)`, id, descriptor.ResourceID, raw)
	for _, content := range []struct {
		name string
		data []byte
	}{{name: "null"}, {name: "empty", data: []byte{}}, {name: "nonempty", data: []byte("conflicting original")}} {
		t.Run(content.name, func(t *testing.T) {
			mustQueryExec(t, database, `UPDATE session_resources SET content=$3 WHERE session_id=$1 AND resource_id=$2`, id, descriptor.ResourceID, content.data)
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				saved, e := base.(store.SessionResourceDAO).SavedSessionResource(ctx, id, descriptor.ResourceID)
				if e != nil {
					return e
				}
				expected := store.SessionResourceRecord{SessionID: id, Resource: descriptor, HasInlineContent: content.data != nil}
				if !reflect.DeepEqual(saved, expected) {
					t.Fatal("saved resource did not report inline presence without interpreting its descriptor", saved, expected)
				}
				return nil
			})
		})
	}
}
