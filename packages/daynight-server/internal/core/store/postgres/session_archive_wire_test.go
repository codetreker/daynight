package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSessionArchivePublicationAndFailureLostCommitReceipt(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "publication", true: "failure receipt"}[failure], func(t *testing.T) {
			db := isolatedStore(t)
			_, owner, _ := testAuthRecords(t, db)
			project := queryProject(t, db, 1)
			task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
			id, claim, fileID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			original := json.RawMessage(`{"sourceEpoch":"original"}`)
			file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "history", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ByteLength: 1, AcceptedOffset: 1, State: "receiving", Path: "history/file", TimelineRevision: 1, Resource: original}
			sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
				dao := scope.SessionDAO()
				if err := dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}}); err != nil {
					return err
				}
				return dao.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
			})
			var armed, lost atomic.Bool
			config := db.Pool.Config().Copy()
			config.ConnConfig.TLSConfig, config.ConnConfig.Fallbacks = nil, nil
			config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
				if err != nil {
					return nil, err
				}
				return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
			}
			pool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			armed.Store(true)
			completion, err := (&Store{Pool: pool}).WriteSession(ctx, func(scope store.SessionScope) error {
				dao := scope.SessionDAO()
				if _, e := dao.LockSession(ctx, id); e != nil {
					return e
				}
				if failure {
					return dao.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, file, json.RawMessage(`{"original":{"sourceEpoch":"original"},"failure":{"code":"quota_exceeded","message":"full"}}`))
				}
				length := "1"
				resource := store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", ByteLength: &length}, BlobID: uuid.NewString(), BlobPath: "blob/original"}
				if e := dao.(store.SessionResourceDAO).InsertSessionResource(ctx, resource); e != nil {
					return e
				}
				file.State = "complete"
				return dao.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
			})
			var tx *store.TransactionError
			if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &tx) || !tx.CommitAttempted || tx.Phase != "commit" {
				t.Fatalf("lost COMMIT confirmation: %+v %v", completion, err)
			}
			sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
				dao := scope.SessionDAO()
				stored, e := dao.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, fileID)
				if e != nil {
					return e
				}
				if failure {
					var metadata struct {
						Original struct {
							SourceEpoch string `json:"sourceEpoch"`
						} `json:"original"`
						Failure struct {
							Code string `json:"code"`
						} `json:"failure"`
					}
					if e = json.Unmarshal(stored.Resource, &metadata); e != nil || stored.State != "failed" || metadata.Original.SourceEpoch != "original" || metadata.Failure.Code != "quota_exceeded" {
						t.Fatalf("original failure receipt: %+v %+v %v", stored, metadata, e)
					}
				} else {
					resource, e := dao.(store.SessionResourceDAO).SavedSessionResource(ctx, id, resourceID)
					if e != nil || stored.State != "complete" || resource.Resource.ResourceID != resourceID {
						t.Fatalf("original publication: %+v %+v %v", stored, resource, e)
					}
				}
				return nil
			})
		})
	}
}
