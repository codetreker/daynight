package session

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type cleanupStoreStub struct {
	list  func(context.Context, string, int) ([]store.ArchiveCleanupTarget, error)
	write func(context.Context, store.ArchiveCleanupTarget, func(store.ArchiveCleanupScope) error) (store.Completion, error)
}

func (d cleanupStoreStub) ListArchiveCleanup(c context.Context, a string, n int) ([]store.ArchiveCleanupTarget, error) {
	return d.list(c, a, n)
}
func (d cleanupStoreStub) WriteArchiveCleanup(c context.Context, v store.ArchiveCleanupTarget, f func(store.ArchiveCleanupScope) error) (store.Completion, error) {
	return d.write(c, v, f)
}

type cleanupScopeStub struct {
	store.ArchiveCleanupScope
	target   store.ArchiveCleanupTarget
	dao      store.SessionDAO
	complete func(context.Context, time.Time) error
}

func (s cleanupScopeStub) Target() store.ArchiveCleanupTarget { return s.target }
func (s cleanupScopeStub) SessionDAO() store.SessionDAO       { return s.dao }
func (s cleanupScopeStub) CompleteArchiveCleanup(c context.Context, at time.Time) error {
	return s.complete(c, at)
}

type cleanupMediaStub struct {
	store.SessionDAO
	store.SessionResourceDAO
	store.SessionResourceSettlementDAO
	resources func(context.Context, string) ([]store.SessionResourceRecord, error)
	leases    func(context.Context, string) ([]store.SessionResourceLease, error)
	release   func(context.Context, string, string) error
	remove    func(context.Context, string, string) error
}

func (d cleanupMediaStub) ListSessionResources(c context.Context, id string) ([]store.SessionResourceRecord, error) {
	return d.resources(c, id)
}
func (d cleanupMediaStub) ListSessionResourceLeases(c context.Context, id string) ([]store.SessionResourceLease, error) {
	return d.leases(c, id)
}
func (d cleanupMediaStub) ReleaseSessionResourceLease(c context.Context, id, lease string) error {
	return d.release(c, id, lease)
}
func (d cleanupMediaStub) DeleteReclaimedSessionResource(c context.Context, id, res string) error {
	return d.remove(c, id, res)
}

type cleanupFiles struct {
	filestorage.Storage
	deleteArchive func(context.Context, sessionarchive.Namespace) error
}

func (f cleanupFiles) DeleteSessionArchives(c context.Context, n sessionarchive.Namespace) error {
	return f.deleteArchive(c, n)
}

type cleanupLeaseFiles struct {
	cleanupFiles
	permits map[string]*cleanupLeasePermit
}

func (f cleanupLeaseFiles) TryAcquireResidency(_ context.Context, key string) (io.Closer, error) {
	permit, ok := f.permits[key]
	if !ok {
		return nil, errors.New("unexpected archive cleanup gate " + key)
	}
	return permit, nil
}

type cleanupLeasePermit struct {
	lose   context.CancelCauseFunc
	closed bool
}

func (p *cleanupLeasePermit) GateContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(parent)
	p.lose = cancel
	return ctx, func() { cancel(context.Canceled) }
}

func (p *cleanupLeasePermit) Close() error {
	p.closed = true
	return nil
}

func cleanupTarget() store.ArchiveCleanupTarget {
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	return store.ArchiveCleanupTarget{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), SessionID: uuid.NewString(), OwnerID: uuid.NewString(), ExpiredAt: &at}
}
func cleanupLocal(t *testing.T) *local.Storage {
	t.Helper()
	f, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.Close(); err != nil {
			t.Error(err)
		}
	})
	return f
}
func cleanupPut(t *testing.T, f filestorage.Storage, bucket, path, content string) {
	t.Helper()
	if _, err := f.Put(t.Context(), bucket, path, strings.NewReader(content)); err != nil {
		t.Fatal(err)
	}
}
func cleanupContent(t *testing.T, f filestorage.Storage, bucket, path, want string) {
	t.Helper()
	obj, err := f.Open(t.Context(), bucket, path)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(obj.Body)
	closeErr := obj.Body.Close()
	if readErr != nil || closeErr != nil || string(got) != want {
		t.Fatalf("content %q %v %v", got, readErr, closeErr)
	}
}
func cleanupAbsent(t *testing.T, f filestorage.Storage, bucket, path string) {
	t.Helper()
	obj, err := f.Open(t.Context(), bucket, path)
	if err == nil {
		obj.Body.Close()
		t.Fatal("deleted content still exists")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestArchiveCleanupRequiresConfirmedExpirationCommit(t *testing.T) {
	failure := errors.New("write completion failed")
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		err     error
	}{
		{"unknown", store.TransactionUnknown, nil}, {"not committed", store.TransactionNotCommitted, nil}, {"committed with cleanup failure", store.TransactionCommitted, failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			target := cleanupTarget()
			calls := 0
			scope := cleanupScopeStub{target: target}
			db := cleanupStoreStub{write: func(c context.Context, v store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
				calls++
				if v != target || calls != 1 {
					t.Fatal("unexpected write")
				}
				if err := work(scope); err != nil {
					t.Fatal(err)
				}
				return store.Completion{Outcome: tc.outcome}, tc.err
			}}
			cleanup := NewArchiveCleanup(db, nil)
			cleanup.expire = func(c context.Context, s store.ArchiveCleanupScope, at time.Time) (bool, error) {
				if s.Target() != scope.Target() {
					t.Fatal("scope changed")
				}
				return true, nil
			}
			err := cleanup.clean(t.Context(), target)
			if err == nil || calls != 1 || (tc.err != nil && !errors.Is(err, tc.err)) {
				t.Fatalf("unconfirmed cleanup continued: %v", err)
			}
		})
	}
}

func TestArchiveCleanupWaitsForArchiveResponseOrUploadGate(t *testing.T) {
	f := cleanupLocal(t)
	target := cleanupTarget()
	n, _ := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
	path := n.Directory() + "/original"
	cleanupPut(t, f, sessionarchive.Bucket, path, "archive bytes")
	reader, err := f.Open(t.Context(), sessionarchive.Bucket, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Body.Close()
	permit, err := f.TryAcquireResidency(t.Context(), "session/archive/owner/"+target.OwnerID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	calls := 0
	db := cleanupStoreStub{write: func(c context.Context, v store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
		calls++
		if calls != 1 {
			t.Fatal("observed files before original owner exited")
		}
		return store.Completion{Outcome: store.TransactionCommitted}, work(cleanupScopeStub{target: target})
	}}
	cleanup := NewArchiveCleanup(db, f)
	cleanup.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
	if err := cleanup.clean(t.Context(), target); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader.Body)
	if err != nil || string(data) != "archive bytes" {
		t.Fatalf("reader lost content %q %v", data, err)
	}
	cleanupContent(t, f, sessionarchive.Bucket, path, "archive bytes")
}

func TestArchiveCleanupMediaGateAndRestartPreserveIndependentBytes(t *testing.T) {
	f := cleanupLocal(t)
	target := cleanupTarget()
	n, _ := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
	path := n.Directory() + "/timeline"
	cleanupPut(t, f, sessionarchive.Bucket, path, "timeline")
	exclusive, shared := uuid.NewString(), uuid.NewString()
	exclusivePath, _ := core.BlobAddress(target.ProjectID, target.OwnerID, target.SessionID, exclusive)
	sharedPath, _ := core.BlobAddress(target.ProjectID, target.OwnerID, target.SessionID, shared)
	cleanupPut(t, f, sessionresource.Bucket, exclusivePath, "exclusive")
	cleanupPut(t, f, sessionresource.Bucket, sharedPath, "shared")
	cleanupPut(t, f, attachment.Bucket, "independent/task.txt", "task attachment")
	botNamespace, _ := sessionarchive.NewNamespace(sessionarchive.Users, target.OwnerID, uuid.NewString())
	botPath := botNamespace.Directory() + "/cache"
	cleanupPut(t, f, sessionarchive.Bucket, botPath, "bot cache")
	lease := store.SessionResourceLease{SessionID: target.SessionID, ID: uuid.NewString(), ResourceID: exclusive}
	gate, err := f.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	resources := []store.SessionResourceRecord{{SessionID: target.SessionID, Resource: sp.Resource{ResourceID: exclusive}, BlobID: exclusive, BlobPath: exclusivePath, GCPending: true}, {SessionID: target.SessionID, Resource: sp.Resource{ResourceID: shared}, BlobID: shared, BlobPath: sharedPath}}
	releases, removes, completes := 0, 0, 0
	dao := cleanupMediaStub{resources: func(c context.Context, id string) ([]store.SessionResourceRecord, error) {
		if id != target.SessionID {
			t.Fatal("wrong resources")
		}
		return resources, nil
	}, leases: func(c context.Context, id string) ([]store.SessionResourceLease, error) {
		return []store.SessionResourceLease{lease}, nil
	}, release: func(c context.Context, id, l string) error {
		if id != target.SessionID || l != lease.ID {
			t.Fatal("wrong lease")
		}
		releases++
		return nil
	}, remove: func(c context.Context, id, r string) error {
		if id != target.SessionID || r != exclusive {
			t.Fatal("shared resource reclaimed")
		}
		removes++
		cleanupAbsent(t, f, sessionresource.Bucket, exclusivePath)
		return nil
	}}
	scope := cleanupScopeStub{target: target, dao: dao, complete: func(c context.Context, at time.Time) error { completes++; return nil }}
	db := cleanupStoreStub{write: func(c context.Context, v store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
		if v != target {
			t.Fatal("wrong target")
		}
		return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
	}}
	makeCleanup := func(files filestorage.Storage) *ArchiveCleanup {
		s := NewArchiveCleanup(db, files)
		s.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
		return s
	}
	if err := makeCleanup(f).clean(t.Context(), target); err != nil {
		t.Fatal(err)
	}
	if releases != 0 || removes != 0 || completes != 0 {
		t.Fatal("busy original reader was reclaimed")
	}
	cleanupContent(t, f, sessionresource.Bucket, exclusivePath, "exclusive")
	if err := gate.Close(); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("disk deletion failed")
	failing := cleanupFiles{Storage: f, deleteArchive: func(context.Context, sessionarchive.Namespace) error { return failure }}
	if err := makeCleanup(failing).clean(t.Context(), target); !errors.Is(err, failure) {
		t.Fatalf("lost physical failure: %v", err)
	}
	if removes != 0 || completes != 0 {
		t.Fatal("failed deletion marked complete")
	}
	// A fresh service consumes separately supplied expired facts. The mock does
	// not infer persistence from the previous callback or its completion value.
	if err := makeCleanup(f).clean(t.Context(), target); err != nil {
		t.Fatal(err)
	}
	if releases != 2 || removes != 1 || completes != 1 {
		t.Fatalf("recovery calls %d %d %d", releases, removes, completes)
	}
	cleanupAbsent(t, f, sessionarchive.Bucket, path)
	cleanupAbsent(t, f, sessionresource.Bucket, exclusivePath)
	cleanupContent(t, f, sessionresource.Bucket, sharedPath, "shared")
	cleanupContent(t, f, attachment.Bucket, "independent/task.txt", "task attachment")
	cleanupContent(t, f, sessionarchive.Bucket, botPath, "bot cache")
}

func TestArchiveCleanupStopsWhenHeldGateIsLost(t *testing.T) {
	for _, tc := range []struct {
		name        string
		loseOwner   bool
		afterDelete bool
	}{
		{name: "owner lost before deletion", loseOwner: true},
		{name: "earlier media permit lost before deletion"},
		{name: "earlier media permit lost after deletion", afterDelete: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			target := cleanupTarget()
			localFiles := cleanupLocal(t)
			namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			path := namespace.Directory() + "/timeline"
			cleanupPut(t, localFiles, sessionarchive.Bucket, path, "archive")

			owner, firstMedia, secondMedia := &cleanupLeasePermit{}, &cleanupLeasePermit{}, &cleanupLeasePermit{}
			lost := firstMedia
			if tc.loseOwner {
				lost = owner
			}
			firstID, secondID := uuid.NewString(), uuid.NewString()
			files := cleanupLeaseFiles{
				cleanupFiles: cleanupFiles{
					Storage: localFiles,
					deleteArchive: func(ctx context.Context, namespace sessionarchive.Namespace) error {
						if lost.lose == nil {
							t.Fatal("cleanup did not bind the held lease to its work")
						}
						if !tc.afterDelete {
							lost.lose(filestorage.ErrGateLost)
							return localFiles.DeleteSessionArchives(ctx, namespace)
						}
						if err := localFiles.DeleteSessionArchives(ctx, namespace); err != nil {
							return err
						}
						lost.lose(filestorage.ErrGateLost)
						return nil
					},
				},
				permits: map[string]*cleanupLeasePermit{
					"session/archive/owner/" + target.OwnerID:        owner,
					"media-lease/session-resource-lease/" + firstID:  firstMedia,
					"media-lease/session-resource-lease/" + secondID: secondMedia,
				},
			}
			var released []string
			dao := cleanupMediaStub{
				resources: func(context.Context, string) ([]store.SessionResourceRecord, error) { return nil, nil },
				leases: func(context.Context, string) ([]store.SessionResourceLease, error) {
					return []store.SessionResourceLease{{ID: firstID}, {ID: secondID}}, nil
				},
				release: func(_ context.Context, sessionID, leaseID string) error {
					if sessionID != target.SessionID {
						t.Fatalf("release targeted session %s", sessionID)
					}
					released = append(released, leaseID)
					return nil
				},
			}
			scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error {
				t.Fatal("marked archive cleanup complete after losing a gate")
				return nil
			}}
			db := cleanupStoreStub{write: func(_ context.Context, _ store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
				if err := work(scope); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			cleanup := NewArchiveCleanup(db, files)
			cleanup.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
			if err := cleanup.clean(t.Context(), target); !errors.Is(err, filestorage.ErrGateLost) {
				t.Fatalf("cleanup after losing a gate: %v", err)
			}
			if len(released) != 2 || released[0] != firstID || released[1] != secondID {
				t.Fatalf("unexpected lease releases: %v", released)
			}
			if !owner.closed || !firstMedia.closed || !secondMedia.closed {
				t.Fatal("cleanup did not release all held gates")
			}
			if tc.afterDelete {
				cleanupAbsent(t, localFiles, sessionarchive.Bucket, path)
			} else {
				cleanupContent(t, localFiles, sessionarchive.Bucket, path, "archive")
			}
		})
	}
}

func TestArchiveCleanupSweepAdvancesAcrossFailures(t *testing.T) {
	failure := errors.New("candidate failed")
	targets := make([]store.ArchiveCleanupTarget, 32)
	for i := range targets {
		targets[i] = cleanupTarget()
	}
	calls := 0
	db := cleanupStoreStub{list: func(c context.Context, after string, limit int) ([]store.ArchiveCleanupTarget, error) {
		if after != "previous" || limit != 32 {
			t.Fatal("wrong page")
		}
		return targets, nil
	}, write: func(c context.Context, target store.ArchiveCleanupTarget, f func(store.ArchiveCleanupScope) error) (store.Completion, error) {
		calls++
		if calls == 1 {
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}
		return store.Completion{Outcome: store.TransactionCommitted}, f(cleanupScopeStub{target: target})
	}}
	s := NewArchiveCleanup(db, nil)
	s.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return false, nil }
	next, err := s.Sweep(t.Context(), "previous")
	if !errors.Is(err, failure) || next != targets[31].SessionID || calls != 32 {
		t.Fatalf("page stalled %q %d %v", next, calls, err)
	}
	db.list = func(context.Context, string, int) ([]store.ArchiveCleanupTarget, error) { return nil, nil }
	s.db = db
	next, err = s.Sweep(t.Context(), next)
	if err != nil || next != "" {
		t.Fatalf("scan not reset %q %v", next, err)
	}
	db.list = func(context.Context, string, int) ([]store.ArchiveCleanupTarget, error) { return nil, failure }
	s.db = db
	next, err = s.Sweep(t.Context(), "retain")
	if next != "retain" || !errors.Is(err, failure) {
		t.Fatal("failed list changed cursor")
	}
}

func TestArchiveCleanupRefusesInconsistentOrFailedResourceObservation(t *testing.T) {
	failure := errors.New("resource observation failed")
	for _, stage := range []string{"barrier", "capability", "resources", "leases", "lease release", "wrong blob path", "missing content", "resource finish", "complete"} {
		t.Run(stage, func(t *testing.T) {
			f := cleanupLocal(t)
			target := cleanupTarget()
			n, _ := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
			archivePath := n.Directory() + "/original"
			cleanupPut(t, f, sessionarchive.Bucket, archivePath, "archive")
			resourceID := uuid.NewString()
			blobPath, _ := core.BlobAddress(target.ProjectID, target.OwnerID, target.SessionID, resourceID)
			cleanupPut(t, f, sessionresource.Bucket, blobPath, "original")
			resource := store.SessionResourceRecord{SessionID: target.SessionID, Resource: sp.Resource{ResourceID: resourceID}, BlobID: resourceID, BlobPath: blobPath, GCPending: true}
			if stage == "wrong blob path" {
				resource.BlobPath = "outside/selected/session"
			}
			if stage == "missing content" {
				resource.BlobID, resource.BlobPath = "", ""
				resource.Resource.Status = "available"
			}
			removes, completes := 0, 0
			dao := cleanupMediaStub{
				resources: func(context.Context, string) ([]store.SessionResourceRecord, error) {
					if stage == "resources" {
						return nil, failure
					}
					return []store.SessionResourceRecord{resource}, nil
				},
				leases: func(context.Context, string) ([]store.SessionResourceLease, error) {
					if stage == "leases" {
						return nil, failure
					}
					if stage == "lease release" {
						return []store.SessionResourceLease{{ID: uuid.NewString(), SessionID: target.SessionID}}, nil
					}
					return nil, nil
				},
				release: func(context.Context, string, string) error { return failure },
				remove: func(context.Context, string, string) error {
					removes++
					if stage == "resource finish" {
						return failure
					}
					return nil
				},
			}
			scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error { completes++; return failure }}
			if stage == "barrier" {
				scope.target.ExpiredAt = nil
			}
			if stage == "capability" {
				scope.dao = nil
			}
			db := cleanupStoreStub{write: func(ctx context.Context, v store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
				return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
			}}
			s := NewArchiveCleanup(db, f)
			s.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
			err := s.clean(t.Context(), target)
			if err == nil {
				t.Fatal("continued after invalid cleanup facts")
			}
			if stage == "resources" || stage == "leases" || stage == "lease release" || stage == "resource finish" || stage == "complete" {
				if !errors.Is(err, failure) {
					t.Fatalf("lost cause %v", err)
				}
			}
			if stage != "complete" && completes != 0 {
				t.Fatal("failed cleanup marked complete")
			}
			if stage != "resource finish" && stage != "complete" {
				if removes != 0 {
					t.Fatal("failed observation released metadata")
				}
				cleanupContent(t, f, sessionresource.Bucket, blobPath, "original")
			}
		})
	}
}

func TestArchiveCleanupUnavailableDescriptorsNeedNoContent(t *testing.T) {
	for _, status := range []string{"unavailable", "failed"} {
		t.Run(status, func(t *testing.T) {
			target := cleanupTarget()
			files := cleanupLocal(t)
			namespace, _ := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
			path := namespace.Directory() + "/timeline"
			cleanupPut(t, files, sessionarchive.Bucket, path, "message with missing image")
			reason := "original image is no longer available"
			// SealArchive persists unavailable descriptors without blob or inline
			// content. Their metadata still carries an archive-owned reference.
			descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: status, Name: "missing-image.png", Error: &reason}
			removes, completes := 0, 0
			dao := cleanupMediaStub{
				resources: func(context.Context, string) ([]store.SessionResourceRecord, error) {
					return []store.SessionResourceRecord{{SessionID: target.SessionID, Resource: descriptor, GCPending: true}}, nil
				},
				leases: func(context.Context, string) ([]store.SessionResourceLease, error) { return nil, nil },
				remove: func(_ context.Context, id, resource string) error {
					if id != target.SessionID || resource != descriptor.ResourceID {
						t.Fatal("wrong descriptor retired")
					}
					removes++
					return nil
				},
			}
			scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error { completes++; return nil }}
			db := cleanupStoreStub{write: func(ctx context.Context, v store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
				if v != target {
					t.Fatal("wrong cleanup target")
				}
				return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
			}}
			cleanup := NewArchiveCleanup(db, files)
			cleanup.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
			if err := cleanup.clean(t.Context(), target); err != nil {
				t.Fatal(err)
			}
			if removes != 1 || completes != 1 {
				t.Fatalf("descriptor retirement=%d completion=%d", removes, completes)
			}
			cleanupAbsent(t, files, sessionarchive.Bucket, path)
		})
	}
}

func TestArchiveCleanupSweepSkipsHeldUploadLeaseAndContinues(t *testing.T) {
	files := cleanupLocal(t)
	busy, ready := cleanupTarget(), cleanupTarget()
	lease := store.SessionResourceLease{SessionID: busy.SessionID, ID: uuid.NewString(), Kind: "upload"}
	gate, err := files.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	paths := map[string]string{}
	for _, target := range []store.ArchiveCleanupTarget{busy, ready} {
		namespace, _ := sessionarchive.NewNamespace(sessionarchive.Projects, target.ProjectID, target.SessionID)
		paths[target.SessionID] = namespace.Directory() + "/staging/chunk"
		cleanupPut(t, files, sessionarchive.Bucket, paths[target.SessionID], "pending original bytes")
	}
	completed := []string{}
	db := cleanupStoreStub{
		list: func(context.Context, string, int) ([]store.ArchiveCleanupTarget, error) {
			return []store.ArchiveCleanupTarget{busy, ready}, nil
		},
		write: func(ctx context.Context, target store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
			dao := cleanupMediaStub{
				resources: func(context.Context, string) ([]store.SessionResourceRecord, error) { return nil, nil },
				leases: func(context.Context, string) ([]store.SessionResourceLease, error) {
					if target.SessionID == busy.SessionID {
						return []store.SessionResourceLease{lease}, nil
					}
					return nil, nil
				},
				release: func(context.Context, string, string) error { t.Fatal("released live upload lease"); return nil },
			}
			scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error { completed = append(completed, target.SessionID); return nil }}
			return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
		},
	}
	cleanup := NewArchiveCleanup(db, files)
	cleanup.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
	next, err := cleanup.Sweep(t.Context(), "")
	if err != nil || next != "" || len(completed) != 1 || completed[0] != ready.SessionID {
		t.Fatalf("held upload blocked other cleanup: %q %v %v", next, completed, err)
	}
	cleanupContent(t, files, sessionarchive.Bucket, paths[busy.SessionID], "pending original bytes")
	cleanupAbsent(t, files, sessionarchive.Bucket, paths[ready.SessionID])
}

func TestArchiveCleanupInlineResourceAndCancelledPage(t *testing.T) {
	target := cleanupTarget()
	resource := uuid.NewString()
	removes, completes := 0, 0
	dao := cleanupMediaStub{
		resources: func(context.Context, string) ([]store.SessionResourceRecord, error) {
			return []store.SessionResourceRecord{{SessionID: target.SessionID, Resource: sp.Resource{ResourceID: resource}, HasInlineContent: true, GCPending: true}}, nil
		},
		leases: func(context.Context, string) ([]store.SessionResourceLease, error) { return nil, nil },
		remove: func(_ context.Context, id, res string) error {
			if id != target.SessionID || res != resource {
				t.Fatal("wrong inline row")
			}
			removes++
			return nil
		},
	}
	scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error { completes++; return nil }}
	db := cleanupStoreStub{write: func(ctx context.Context, _ store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
	}}
	s := NewArchiveCleanup(db, cleanupLocal(t))
	s.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
	if err := s.clean(t.Context(), target); err != nil || removes != 1 || completes != 1 {
		t.Fatalf("inline cleanup %d %d %v", removes, completes, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	db.list = func(context.Context, string, int) ([]store.ArchiveCleanupTarget, error) {
		cancel()
		return []store.ArchiveCleanupTarget{target}, nil
	}
	s.db = db
	next, err := s.Sweep(ctx, "previous")
	if next != "previous" || !errors.Is(err, context.Canceled) || removes != 1 {
		t.Fatalf("cancelled page advanced: %q %v", next, err)
	}
}
