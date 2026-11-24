package azure

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/runtime"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/appendblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/lease"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

const archiveChunkSize = 1 << 20

func (*Storage) ArchiveStagingChunkSize() int { return archiveChunkSize }

// Archive operations and whole-Session sweeps share one process-local permit.
// A finite Blob lease additionally fences each staging object's writes.
func (s *Storage) archivePermit(ctx context.Context, n sessionarchive.Namespace) (io.Closer, error) {
	if err := n.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %w", filestorage.ErrInvalidAddress, err)
	}
	return s.Gates.TryAcquireResidency(ctx, "azure/archive/"+n.Directory())
}

func (s *Storage) AcquireArchiveStaging(ctx context.Context, n sessionarchive.Namespace, _ bool) (filestorage.ArchiveStaging, error) {
	permit, err := s.archivePermit(ctx, n)
	if err != nil {
		return nil, err
	}
	return &archiveStaging{storage: s, namespace: n, permit: permit, leases: make(map[string]*archiveLease)}, nil
}

type archiveLease struct {
	client *lease.BlobClient
	ctx    context.Context
	cancel context.CancelCauseFunc
	done   chan struct{}
	mu     sync.Mutex
	until  time.Time
}

func newArchiveLease(ctx context.Context, client *blob.Client) (*archiveLease, error) {
	return newArchiveLeaseWithTicks(ctx, client, nil, nil)
}

func newArchiveLeaseWithTicks(ctx context.Context, client *blob.Client, ticks <-chan time.Time, renewed func()) (*archiveLease, error) {
	lc, err := lease.NewBlobClient(client, nil)
	if err != nil {
		return nil, err
	}
	// Never replay an acquisition whose result could be unknown.
	started := time.Now()
	_, err = lc.AcquireLease(singleAttempt(ctx), 60, nil)
	if err != nil {
		if missing(err) {
			if gateErr := filestorage.GateError(ctx); gateErr != nil {
				return nil, gateErr
			}
			return nil, filestorage.ErrArchiveStagingMissing
		}
		var response *azcore.ResponseError
		if errors.As(err, &response) && response.StatusCode == 409 {
			return nil, errors.Join(filestorage.ErrGateBusy, err)
		}
		return nil, err
	}
	leaseCtx, cancel := context.WithCancelCause(context.Background())
	l := &archiveLease{client: lc, ctx: leaseCtx, cancel: cancel, done: make(chan struct{}), until: started.Add(50 * time.Second)}
	go func() {
		defer close(l.done)
		if ticks == nil {
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			ticks = ticker.C
		}
		l.renew(ticks, renewed)
	}()
	if err := l.check(); err != nil {
		return nil, errors.Join(err, l.close(false))
	}
	return l, nil
}

func (l *archiveLease) check() error {
	l.mu.Lock()
	expired := !time.Now().Before(l.until)
	l.mu.Unlock()
	if expired {
		l.cancel(filestorage.ErrGateLost)
	}
	return context.Cause(l.ctx)
}

func (l *archiveLease) renew(ticks <-chan time.Time, renewed func()) {
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticks:
			if l.check() != nil {
				return
			}
			started := time.Now()
			ctx, cancel := context.WithTimeout(l.ctx, 10*time.Second)
			_, err := l.client.RenewLease(singleAttempt(ctx), nil)
			cancel()
			if err != nil {
				l.cancel(errors.Join(filestorage.ErrGateLost, err))
				return
			}
			if l.check() != nil {
				return
			}
			l.mu.Lock()
			l.until = started.Add(50 * time.Second)
			l.mu.Unlock()
			if l.check() != nil {
				return
			}
			if renewed != nil {
				renewed()
			}
		}
	}
}

func (l *archiveLease) bind(ctx context.Context) (context.Context, context.CancelFunc) {
	bound, cancel := context.WithCancelCause(ctx)
	if err := l.check(); err != nil {
		cancel(err)
	}
	stop := context.AfterFunc(l.ctx, func() { cancel(context.Cause(l.ctx)) })
	return bound, func() { stop(); cancel(context.Canceled) }
}
func (l *archiveLease) close(deleted bool) error {
	cause := context.Cause(l.ctx)
	l.cancel(context.Canceled)
	<-l.done
	if deleted {
		return cause
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := l.client.ReleaseLease(singleAttempt(ctx), nil)
	return errors.Join(cause, err)
}
func singleAttempt(ctx context.Context) context.Context {
	return runtime.WithRetryOptions(ctx, policy.RetryOptions{MaxRetries: -1})
}

type archiveBytes struct{ *bytes.Reader }

func (archiveBytes) Close() error { return nil }

type archiveStaging struct {
	storage        *Storage
	namespace      sessionarchive.Namespace
	permit         io.Closer
	mu             sync.Mutex
	leases         map[string]*archiveLease
	closed, frozen bool
	readers        int
	viewID         string
	viewETag       azcore.ETag
	viewLength     int64
}

func (s *archiveStaging) ready(ctx context.Context, mutable bool) error {
	if s.closed {
		return os.ErrClosed
	}
	if mutable && s.frozen {
		return filestorage.ErrGateBusy
	}
	return check(ctx)
}
func (s *archiveStaging) name(id string) (string, error) {
	path, err := filestorage.ArchiveStagingPath(s.namespace, id)
	if err != nil {
		return "", err
	}
	return sessionarchive.Bucket + "/" + path, nil
}
func (s *archiveStaging) getLease(ctx context.Context, name string) (*archiveLease, error) {
	if l := s.leases[name]; l != nil {
		if err := l.check(); err != nil {
			return nil, err
		}
		return l, nil
	}
	l, err := newArchiveLease(ctx, s.storage.client.NewBlobClient(name))
	if err == nil {
		s.leases[name] = l
	}
	return l, err
}
func leaseConditions(l *archiveLease) *blob.AccessConditions {
	return &blob.AccessConditions{LeaseAccessConditions: &blob.LeaseAccessConditions{LeaseID: l.client.LeaseID()}}
}
func (s *archiveStaging) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	if s.readers != 0 {
		return filestorage.ErrGateBusy
	}
	s.closed = true
	var result error
	for _, l := range s.leases {
		result = errors.Join(result, l.close(false))
	}
	return errors.Join(result, s.permit.Close())
}
func (s *archiveStaging) Create(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, true); err != nil {
		return err
	}
	name, err := s.name(id)
	if err != nil {
		return err
	}
	star := azcore.ETag("*")
	_, err = s.storage.client.NewAppendBlobClient(name).Create(singleAttempt(ctx), &appendblob.CreateOptions{AccessConditions: &blob.AccessConditions{ModifiedAccessConditions: &blob.ModifiedAccessConditions{IfNoneMatch: &star}}})
	var response *azcore.ResponseError
	if errors.As(err, &response) && (response.StatusCode == 409 || response.StatusCode == 412) {
		return errors.Join(fs.ErrExist, err)
	}
	return errors.Join(err, filestorage.GateError(ctx))
}
func (s *archiveStaging) props(ctx context.Context, name string, total int64) (int64, azcore.ETag, *archiveLease, error) {
	l, err := s.getLease(ctx, name)
	if err != nil {
		return 0, "", nil, err
	}
	bound, cancel := l.bind(ctx)
	defer cancel()
	p, err := s.storage.client.NewBlobClient(name).GetProperties(bound, &blob.GetPropertiesOptions{AccessConditions: leaseConditions(l)})
	if missing(err) {
		if gateErr := errors.Join(filestorage.GateError(ctx), l.check()); gateErr != nil {
			return 0, "", nil, gateErr
		}
		return 0, "", nil, filestorage.ErrArchiveStagingMissing
	}
	if err != nil {
		return 0, "", nil, errors.Join(err, context.Cause(l.ctx))
	}
	if p.ContentLength == nil || p.ETag == nil || p.BlobType == nil || *p.BlobType != blob.BlobTypeAppendBlob {
		return 0, "", nil, filestorage.ErrArchiveStagingCorrupt
	}
	size := *p.ContentLength
	if total < 0 || size < 0 || size > total {
		return 0, "", nil, filestorage.ErrArchiveStagingCorrupt
	}
	if err = errors.Join(filestorage.GateError(ctx), context.Cause(l.ctx)); err != nil {
		return 0, "", nil, err
	}
	return size, *p.ETag, l, nil
}
func (s *archiveStaging) AdoptEmpty(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, true); err != nil {
		return err
	}
	name, err := s.name(id)
	if err != nil {
		return err
	}
	_, _, _, err = s.props(ctx, name, 0)
	if errors.Is(err, filestorage.ErrArchiveStagingCorrupt) {
		return filestorage.ErrArchiveStagingOffset
	}
	return err
}
func (s *archiveStaging) Observe(ctx context.Context, id string, total int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, false); err != nil {
		return 0, err
	}
	name, err := s.name(id)
	if err != nil {
		return 0, err
	}
	size, _, _, err := s.props(ctx, name, total)
	return size, err
}
func (s *archiveStaging) Append(ctx context.Context, id string, total, expected int64, data []byte) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, true); err != nil {
		return 0, err
	}
	if total < 0 || expected < 0 || expected > total || len(data) == 0 || int64(len(data)) != min(int64(archiveChunkSize), total-expected) {
		return 0, filestorage.ErrArchiveStagingOffset
	}
	name, err := s.name(id)
	if err != nil {
		return 0, err
	}
	size, _, l, err := s.props(ctx, name, total)
	if err != nil {
		return 0, err
	}
	if size != expected {
		return size, filestorage.ErrArchiveStagingOffset
	}
	if err = check(ctx); err != nil {
		return size, err
	}
	bound, cancel := l.bind(ctx)
	defer cancel()
	result, err := s.storage.client.NewAppendBlobClient(name).AppendBlock(singleAttempt(bound), archiveBytes{bytes.NewReader(data)}, &appendblob.AppendBlockOptions{AccessConditions: leaseConditions(l), AppendPositionAccessConditions: &appendblob.AppendPositionAccessConditions{AppendPosition: &expected, MaxSize: &total}})
	if err != nil {
		var response *azcore.ResponseError
		if errors.As(err, &response) && response.ErrorCode == "AppendPositionConditionNotMet" {
			observed, _, _, observeErr := s.props(ctx, name, total)
			return observed, errors.Join(filestorage.ErrArchiveStagingOffset, observeErr)
		}
		return size, errors.Join(err, context.Cause(l.ctx))
	}
	if result.BlobAppendOffset == nil {
		return size, errors.New("Azure append response lacks offset")
	}
	offset, err := strconv.ParseInt(*result.BlobAppendOffset, 10, 64)
	if err != nil || offset != expected {
		return size, errors.New("Azure append returned unexpected offset")
	}
	return size + int64(len(data)), errors.Join(filestorage.GateError(ctx), context.Cause(l.ctx))
}
func (s *archiveStaging) Open(ctx context.Context, id string, total int64) (filestorage.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, false); err != nil {
		return filestorage.Object{}, err
	}
	name, err := s.name(id)
	if err != nil {
		return filestorage.Object{}, err
	}
	size, etag, l, err := s.props(ctx, name, total)
	if err != nil {
		return filestorage.Object{}, err
	}
	if s.frozen && (s.viewID != id || s.viewETag != etag || s.viewLength != size) {
		return filestorage.Object{}, filestorage.ErrArchiveStagingCorrupt
	}
	bound, cancel := l.bind(ctx)
	conditions := leaseConditions(l)
	conditions.ModifiedAccessConditions = &blob.ModifiedAccessConditions{IfMatch: &etag}
	response, err := s.storage.client.NewBlobClient(name).DownloadStream(bound, &blob.DownloadStreamOptions{AccessConditions: conditions})
	if err != nil {
		cancel()
		return filestorage.Object{}, errors.Join(readError(err), context.Cause(l.ctx))
	}
	if response.ETag == nil || *response.ETag != etag || response.ContentLength == nil || *response.ContentLength != size {
		cancel()
		return filestorage.Object{}, errors.Join(filestorage.ErrArchiveStagingCorrupt, response.Body.Close())
	}
	s.frozen, s.viewID, s.viewETag, s.viewLength = true, id, etag, size
	s.readers++
	return filestorage.Object{Body: &archiveReader{owner: s, lease: l, body: response.NewRetryReader(bound, nil), ctx: bound, cancel: cancel}, Info: filestorage.FileInfo{Size: size}}, nil
}

type archiveReader struct {
	owner  *archiveStaging
	lease  *archiveLease
	body   io.ReadCloser
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
	err    error
}

func (r *archiveReader) Read(p []byte) (int, error) {
	if err := r.lease.check(); err != nil {
		return 0, err
	}
	n, err := (contextReader{r.ctx, r.body}).Read(p)
	if leaseErr := r.lease.check(); leaseErr != nil {
		return n, errors.Join(err, leaseErr)
	}
	return n, err
}
func (r *archiveReader) Close() error {
	r.once.Do(func() {
		r.err = errors.Join(r.body.Close(), filestorage.GateError(r.ctx), r.lease.check())
		r.cancel()
		r.owner.mu.Lock()
		r.owner.readers--
		r.owner.mu.Unlock()
	})
	return r.err
}
func (s *archiveStaging) Publish(ctx context.Context, id string, total int64, bucket, path string) (info filestorage.FileInfo, result error) {
	if _, err := s.name(id); err != nil {
		return info, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: err}
	}
	if !(bucket == sessionarchive.Bucket && path == s.namespace.Directory()+"/files/"+id+"/content") && !(bucket == sessionresource.Bucket && path == s.namespace.Directory()+"/blobs/"+id) {
		return info, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: filestorage.ErrInvalidAddress}
	}
	o, err := s.Open(ctx, id, total)
	if err != nil {
		return info, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: err}
	}
	if o.Info.Size != total {
		return info, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: errors.Join(filestorage.ErrArchiveStagingOffset, o.Body.Close())}
	}
	name, _ := s.name(id)
	s.mu.Lock()
	l := s.leases[name]
	s.mu.Unlock()
	bound, cancel := l.bind(ctx)
	defer cancel()
	info, err = s.storage.Put(bound, bucket, path, o.Body)
	closeErr := o.Body.Close()
	if err != nil {
		return info, errors.Join(err, closeErr)
	}
	if closeErr != nil {
		return info, &filestorage.PublicationError{Outcome: filestorage.Published, Cause: closeErr}
	}
	return info, nil
}
func (s *archiveStaging) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(ctx, true); err != nil {
		return err
	}
	name, err := s.name(id)
	if err != nil {
		return err
	}
	l, err := s.getLease(ctx, name)
	if errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = check(ctx); err != nil {
		return err
	}
	bound, cancel := l.bind(ctx)
	defer cancel()
	_, err = s.storage.client.NewBlobClient(name).Delete(singleAttempt(bound), &blob.DeleteOptions{AccessConditions: leaseConditions(l)})
	if err != nil && !missing(err) {
		return errors.Join(err, context.Cause(l.ctx))
	}
	delete(s.leases, name)
	return errors.Join(l.close(true), filestorage.GateError(ctx))
}
func (s *Storage) OpenArchiveStaging(ctx context.Context, n sessionarchive.Namespace, id string) (filestorage.Object, error) {
	path, err := filestorage.ArchiveStagingPath(n, id)
	if err != nil {
		return filestorage.Object{}, err
	}
	return s.Open(ctx, sessionarchive.Bucket, path)
}
func (s *Storage) withArchivePermit(ctx context.Context, n sessionarchive.Namespace, action func() error) error {
	p, err := s.archivePermit(ctx, n)
	if err != nil {
		return err
	}
	return errors.Join(action(), p.Close())
}
func resourceArchiveNamespace(n sessionresource.Namespace) (sessionarchive.Namespace, error) {
	parts := strings.Split(n.Directory(), "/")
	if len(parts) != 4 {
		return sessionarchive.Namespace{}, filestorage.ErrInvalidAddress
	}
	return sessionarchive.NewNamespace(sessionarchive.Kind(parts[0]), parts[1], parts[3])
}

var _ filestorage.ArchiveStagingBackend = (*Storage)(nil)
var _ filestorage.ArchiveStagingReader = (*Storage)(nil)
