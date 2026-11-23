package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// This DAO supplies independently controlled storage facts and records attempted
// writes. It does not interpret callback execution as a committed transaction.
type v2ContractDAO struct {
	*archiveFlowDAO
	t                                                                *testing.T
	file                                                             store.ArchiveBundleFile
	bundle                                                           store.ArchiveBundle
	fileErr, nextErr, usageErr, leaseErr, saveErr, casErr, bundleErr error
	usage                                                            store.SessionResourceUsage
	leases                                                           []store.SessionResourceLease
	nextExists                                                       bool
	expectList                                                       bool
	listCalls                                                        int
	listErr                                                          error
	listed                                                           []store.ArchiveBundleFile
	leaseCalls                                                       int
	saved                                                            []store.ArchiveBundleFile
	previous, proposed                                               *store.ArchiveBundleFile
	savedBundle                                                      *store.ArchiveBundle
}

func (d *v2ContractDAO) SessionArchiveBundle(context.Context, string) (store.ArchiveBundle, error) {
	return d.bundle, nil
}
func (d *v2ContractDAO) SessionArchiveFile(_ context.Context, _, id string) (store.ArchiveBundleFile, error) {
	if id == d.file.FileID {
		return d.file, d.fileErr
	}
	if d.nextExists {
		return store.ArchiveBundleFile{FileID: id}, nil
	}
	if d.nextErr != nil {
		return store.ArchiveBundleFile{}, d.nextErr
	}
	return store.ArchiveBundleFile{}, model.ErrNotFound
}
func (d *v2ContractDAO) SessionArchiveFiles(_ context.Context, session string) ([]store.ArchiveBundleFile, error) {
	d.listCalls++
	if !d.expectList || d.listCalls != 1 || session != d.file.SessionID {
		d.t.Errorf("unexpected archive file listing: session=%s call=%d", session, d.listCalls)
		return nil, errors.New("unexpected archive file listing")
	}
	return d.listed, d.listErr
}
func (d *v2ContractDAO) SessionResourceUsage(context.Context, string) (store.SessionResourceUsage, error) {
	return d.usage, d.usageErr
}
func (d *v2ContractDAO) ListSessionResourceLeases(context.Context, string) ([]store.SessionResourceLease, error) {
	d.leaseCalls++
	return d.leases, d.leaseErr
}
func (d *v2ContractDAO) SaveSessionArchiveFile(_ context.Context, f store.ArchiveBundleFile) error {
	d.saved = append(d.saved, f)
	return d.saveErr
}
func (d *v2ContractDAO) CompareAndSwapSessionArchiveFile(_ context.Context, old, next store.ArchiveBundleFile) error {
	d.previous = &old
	d.proposed = &next
	return d.casErr
}
func (d *v2ContractDAO) SaveSessionArchiveBundle(_ context.Context, b store.ArchiveBundle) error {
	d.savedBundle = &b
	return d.bundleErr
}

func contractV2(t *testing.T) (*ArchiveOperation, *v2ContractDAO, sessionarchive.Namespace) {
	t.Helper()
	op, base, r := archiveFlowFixture(t)
	proof := sessionarchive.InitialPrefixProof()
	id := uuid.NewString()
	d := &v2ContractDAO{t: t, archiveFlowDAO: base, bundle: *base.bundle, file: store.ArchiveBundleFile{SessionID: op.id, FileID: id, Purpose: "history", SHA256: archiveDigest([]byte("body")), State: "receiving", ByteLength: 4, AcceptedOffset: 4, TimelineRevision: base.bundle.Revision, UploadVersion: 2, PrefixProof: proof[:]}}
	n, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		t.Fatal(err)
	}
	d.file.Path = n.Directory() + "/files/" + id
	d.bundle.HistoryID = id
	op.execution.archiveRun = func(_ context.Context, p model.Principal, _, _, session string, _ bool, work func(*Access) error) error {
		if p != op.principal || session != op.id {
			t.Fatal("wrong archive access scope")
		}
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	return op, d, n
}

func TestV2StagingFailureRequiresUnchangedAuthority(t *testing.T) {
	sentinel := errors.New("controlled failure")
	rejected := errors.New("expected conflict")
	cases := []struct {
		name     string
		setup    func(*v2ContractDAO)
		want     error
		proposed bool
	}{
		{"record failure", func(*v2ContractDAO) {}, nil, true},
		{"usage failure", func(d *v2ContractDAO) { d.usageErr = sentinel }, sentinel, false},
		{"deletion barrier", func(d *v2ContractDAO) { d.usage.Deleting = true }, rejected, false},
		{"epoch changed", func(d *v2ContractDAO) { d.usage.DeleteEpoch = 2 }, rejected, false},
		{"file read failure", func(d *v2ContractDAO) { d.fileErr = sentinel }, sentinel, false},
		{"offset changed", func(d *v2ContractDAO) { d.file.AcceptedOffset++ }, rejected, false},
		{"file revision changed", func(d *v2ContractDAO) { d.file.TimelineRevision++ }, rejected, false},
		{"compare failure", func(d *v2ContractDAO) { d.casErr = sentinel }, sentinel, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op, d, _ := contractV2(t)
			original := d.file
			tc.setup(d)
			err := op.failArchiveStaging(t.Context(), original, 0)
			var f *model.Fault
			if tc.want == nil && err != nil || tc.want == rejected && (!errors.As(err, &f) || f.Code != "session_conflict" && f.Code != "archive_conflict") || tc.want != nil && tc.want != rejected && !errors.Is(err, tc.want) {
				t.Fatalf("failure result %v", err)
			}
			if (d.proposed != nil) != tc.proposed {
				t.Fatalf("unexpected compare: %+v", d.proposed)
			}
			if tc.proposed {
				var failure sp.ImageError
				if e := json.Unmarshal(d.proposed.TerminalError, &failure); e != nil || d.proposed.State != "failed" || failure.Code != "staging_corrupt" || d.savedBundle != nil {
					t.Fatalf("failure facts: %+v %v", d.proposed, e)
				}
			}
		})
	}
}

func TestV2FailureRecordsContentAndQuotaSeparately(t *testing.T) {
	sentinel := errors.New("compare failed")
	for _, tc := range []struct {
		name    string
		cause   error
		setup   func(*v2ContractDAO)
		code    string
		wantErr bool
		bundle  bool
	}{
		{"invalid history", errors.New("bad contents"), func(*v2ContractDAO) {}, "archive_incomplete", false, false},
		{"quota timeline", &model.Fault{Code: "quota_exceeded", Message: "limit"}, func(d *v2ContractDAO) { d.file.Purpose = "timeline"; d.bundle.TimelineID = d.file.FileID }, "quota_exceeded", false, true},
		{"changed proof", nil, func(d *v2ContractDAO) { d.file.PrefixProof = []byte("changed") }, "", true, false},
		{"failed compare", nil, func(d *v2ContractDAO) { d.casErr = sentinel }, "archive_incomplete", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, d, _ := contractV2(t)
			expected := d.file
			tc.setup(d)
			if tc.name == "quota timeline" {
				expected = d.file
			}
			err := op.failArchiveFile(t.Context(), expected, tc.cause)
			if (err != nil) != tc.wantErr {
				t.Fatalf("result %v", err)
			}
			if tc.code != "" {
				var failure sp.ImageError
				if d.proposed == nil || json.Unmarshal(d.proposed.TerminalError, &failure) != nil || failure.Code != tc.code {
					t.Fatalf("wrong failure: %+v", d.proposed)
				}
			}
			if (d.savedBundle != nil) != tc.bundle {
				t.Fatalf("bundle changed: %+v", d.savedBundle)
			}
			if tc.bundle && d.savedBundle.Phase != "failed" {
				t.Fatal("timeline failure must close bundle")
			}
		})
	}
}

type contractDeleteBlocks struct {
	filestorage.Storage
	offsets []int64
	err     error
}

func (s *contractDeleteBlocks) DeleteArchiveBlock(_ context.Context, _ sessionarchive.Namespace, _ string, offset int64) error {
	s.offsets = append(s.offsets, offset)
	return s.err
}

type contractDeleteAll struct {
	*contractDeleteBlocks
	stagingErr   error
	stagingCalls int
}

func TestV2TerminalCleanupStopsOnUncertainOrLiveLease(t *testing.T) {
	sentinel := errors.New("controlled cleanup inventory failure")
	for _, tc := range []struct {
		name       string
		setup      func(*v2ContractDAO)
		wantError  bool
		leaseCalls int
	}{
		{"file inventory failed", func(d *v2ContractDAO) { d.listErr = sentinel }, true, 0},
		{"lease inventory failed", func(d *v2ContractDAO) { d.leaseErr = sentinel }, true, 1},
		{"archive writer still active", func(d *v2ContractDAO) { d.leases = []store.SessionResourceLease{{Kind: "archive"}} }, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, d, _ := contractV2(t)
			d.file.State = "complete"
			d.listed = []store.ArchiveBundleFile{d.file}
			d.expectList = true
			tc.setup(d)
			blocks := &contractDeleteBlocks{Storage: op.execution.files}
			deletion := &contractDeleteAll{contractDeleteBlocks: blocks}
			op.execution.files = deletion
			err := op.cleanupV2Terminal(t.Context())
			if tc.wantError && !errors.Is(err, sentinel) || !tc.wantError && err != nil {
				t.Fatalf("cleanup error = %v", err)
			}
			if d.listCalls != 1 || d.leaseCalls != tc.leaseCalls || len(blocks.offsets) != 0 || deletion.stagingCalls != 0 || d.proposed != nil {
				t.Fatalf("cleanup after uncertain inventory: lists=%d leases=%d offsets=%v staging=%d proposed=%+v", d.listCalls, d.leaseCalls, blocks.offsets, deletion.stagingCalls, d.proposed)
			}
		})
	}
}

func TestV2TerminalCleanupSelectsOnlyUnreleasedTerminalFiles(t *testing.T) {
	op, d, _ := contractV2(t)
	d.file.State = "complete"
	legacy := d.file
	legacy.UploadVersion = 1
	legacy.FileID = uuid.NewString()
	released := d.file
	released.StagingReleased = true
	released.FileID = uuid.NewString()
	receiving := d.file
	receiving.State = "receiving"
	receiving.FileID = uuid.NewString()
	d.expectList = true
	d.listed = []store.ArchiveBundleFile{legacy, released, receiving, d.file}
	blocks := &contractDeleteBlocks{Storage: op.execution.files}
	deletion := &contractDeleteAll{contractDeleteBlocks: blocks}
	op.execution.files = deletion
	if err := op.cleanupV2Terminal(t.Context()); err != nil {
		t.Fatal(err)
	}
	if d.listCalls != 1 || d.leaseCalls != 1 || !reflect.DeepEqual(blocks.offsets, []int64{0}) || deletion.stagingCalls != 1 || d.proposed == nil || d.proposed.FileID != d.file.FileID || !d.proposed.StagingReleased {
		t.Fatalf("cleanup selection: lists=%d leases=%d offsets=%v staging=%d proposed=%+v", d.listCalls, d.leaseCalls, blocks.offsets, deletion.stagingCalls, d.proposed)
	}
}

func (s *contractDeleteAll) DeleteArchiveStaging(context.Context, string, string) error {
	s.stagingCalls++
	return s.stagingErr
}

func TestV2CleanupRequiresDurableDeletesAndMatchingReceipt(t *testing.T) {
	sentinel := errors.New("delete failed")
	for _, tc := range []struct {
		name    string
		setup   func(*v2ContractDAO, *contractDeleteAll)
		wantErr bool
		offsets []int64
		cas     bool
	}{
		{"history released", func(*v2ContractDAO, *contractDeleteAll) {}, false, []int64{0, sessionarchive.BlockSize}, true},
		{"delete failure", func(_ *v2ContractDAO, s *contractDeleteAll) { s.err = sentinel }, true, []int64{0}, false},
		{"staging failure", func(_ *v2ContractDAO, s *contractDeleteAll) { s.stagingErr = sentinel }, true, []int64{0, sessionarchive.BlockSize}, false},
		{"file read failure", func(d *v2ContractDAO, _ *contractDeleteAll) { d.fileErr = sentinel }, true, []int64{0, sessionarchive.BlockSize}, false},
		{"different receipt", func(d *v2ContractDAO, _ *contractDeleteAll) { d.file.SHA256 = "different" }, true, []int64{0, sessionarchive.BlockSize}, false},
		{"already released", func(d *v2ContractDAO, _ *contractDeleteAll) { d.file.StagingReleased = true }, false, []int64{0, sessionarchive.BlockSize}, false},
		{"release compare failed", func(d *v2ContractDAO, _ *contractDeleteAll) { d.casErr = sentinel }, true, []int64{0, sessionarchive.BlockSize}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, d, n := contractV2(t)
			d.file.State = "complete"
			d.file.ByteLength = sessionarchive.BlockSize + 1
			d.file.AcceptedOffset = sessionarchive.BlockSize
			before := d.file
			blocks := &contractDeleteBlocks{Storage: op.execution.files}
			deletion := &contractDeleteAll{contractDeleteBlocks: blocks}
			op.execution.files = deletion
			tc.setup(d, deletion)
			err := op.cleanupV2File(t.Context(), n, before)
			if (err != nil) != tc.wantErr || !reflect.DeepEqual(blocks.offsets, tc.offsets) || (d.proposed != nil) != tc.cas {
				t.Fatalf("result=%v offsets=%v proposed=%+v", err, blocks.offsets, d.proposed)
			}
			if tc.cas && !d.proposed.StagingReleased {
				t.Fatal("release not recorded")
			}
		})
	}
}

func TestV2RestartAdmissionAndWriteFailures(t *testing.T) {
	sentinel := errors.New("controlled restart error")
	cases := []struct {
		name         string
		setup        func(*v2ContractDAO, string)
		wantErr, cas bool
	}{
		{"success", func(*v2ContractDAO, string) {}, false, true},
		{"read error", func(d *v2ContractDAO, _ string) { d.fileErr = sentinel }, true, false},
		{"version", func(d *v2ContractDAO, _ string) { d.file.UploadVersion = 1 }, true, false},
		{"state", func(d *v2ContractDAO, _ string) { d.file.State = "complete" }, true, false},
		{"reason", func(d *v2ContractDAO, _ string) { d.file.TerminalError = []byte(`{"code":"quota_exceeded"}`) }, true, false},
		{"wrong successor", func(d *v2ContractDAO, _ string) { d.file.SuccessorFileID = uuid.NewString() }, true, false},
		{"replay", func(d *v2ContractDAO, next string) { d.file.SuccessorFileID = next }, false, false},
		{"different current history", func(d *v2ContractDAO, _ string) { d.bundle.HistoryID = uuid.NewString() }, true, false},
		{"usage error", func(d *v2ContractDAO, _ string) { d.usageErr = sentinel }, true, false},
		{"delete pending", func(d *v2ContractDAO, _ string) { d.usage.Deleting = true }, true, false},
		{"lease error", func(d *v2ContractDAO, _ string) { d.leaseErr = sentinel }, true, false},
		{"writer lease", func(d *v2ContractDAO, _ string) { d.leases = []store.SessionResourceLease{{Kind: "archive"}} }, true, false},
		{"successor exists", func(d *v2ContractDAO, _ string) { d.nextExists = true }, true, false},
		{"successor lookup failure", func(d *v2ContractDAO, _ string) { d.nextErr = sentinel }, true, false},
		{"successor save failure", func(d *v2ContractDAO, _ string) { d.saveErr = sentinel }, true, false},
		{"original compare failure", func(d *v2ContractDAO, _ string) { d.casErr = sentinel }, true, true},
		{"bundle save failure", func(d *v2ContractDAO, _ string) { d.bundleErr = sentinel }, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op, d, _ := contractV2(t)
			d.file.State = "failed"
			d.file.TerminalError = []byte(`{"code":"staging_corrupt","message":"corrupt"}`)
			next := uuid.NewString()
			tc.setup(d, next)
			d.expectList = tc.name == "success" || tc.name == "replay"
			if d.expectList {
				d.listed = []store.ArchiveBundleFile{}
			}
			out, err := op.RestartArchiveFile(t.Context(), "history", d.file.FileID, next)
			if (err != nil) != tc.wantErr || (d.proposed != nil) != tc.cas {
				t.Fatalf("restart=%+v error=%v compare=%+v", out, err, d.proposed)
			}
			if tc.name == "success" {
				if len(d.saved) != 1 || d.saved[0].FileID != next || d.saved[0].State != "receiving" || d.proposed.SuccessorFileID != next || d.savedBundle == nil || d.savedBundle.HistoryID != next {
					t.Fatalf("restart intent: %v %+v %+v", d.saved, d.proposed, d.savedBundle)
				}
			}
			if tc.name == "replay" && (len(d.saved) != 0 || out.SuccessorFileID == nil || *out.SuccessorFileID != next) {
				t.Fatalf("replay changed identity: %+v", out)
			}
			if d.expectList && d.listCalls != 1 {
				t.Fatalf("expected cleanup listing once, got %d", d.listCalls)
			}
		})
	}
	op, d, _ := contractV2(t)
	if _, err := op.RestartArchiveFile(t.Context(), "history", d.file.FileID, d.file.FileID); err == nil {
		t.Fatal("self successor accepted")
	}
	if _, err := op.RestartArchiveFile(t.Context(), "history", d.file.FileID, "bad"); err == nil {
		t.Fatal("invalid successor accepted")
	}
}
