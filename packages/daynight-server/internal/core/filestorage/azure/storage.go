// Package azure implements ordinary object storage over one Azure Blob container.
package azure

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/runtime"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

const transferBucket = "mcp-transfers"

// Storage leaves gate and client lifetimes with the assembler. Scratch is a
// private, request-scoped local directory on a volume with sufficient space.
type Storage struct {
	filestorage.Gates
	client   *container.Client
	scratch  string
	pageSize *int32
}

func New(client *container.Client, gates filestorage.Gates, scratch string) (*Storage, error) {
	if client == nil || gates == nil || scratch == "" {
		return nil, errors.New("Azure storage requires a container, gates and scratch directory")
	}
	return &Storage{Gates: gates, client: client, scratch: scratch}, nil
}

// BlobName is shared by online access and offline migration. The logical
// attachment path is hashed as originally supplied, without normalization.
func BlobName(bucket, path string) (string, error) {
	if err := filestorage.ValidateAddress(bucket, path); err != nil {
		return "", err
	}
	if bucket != "task-attachments" {
		return bucket + "/" + path, nil
	}
	parts := strings.SplitN(path, "/", 4)
	if len(parts) != 4 {
		return "", filestorage.ErrInvalidAddress
	}
	for _, value := range []string{parts[0], parts[2]} {
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || id.String() != value {
			return "", filestorage.ErrInvalidAddress
		}
	}
	if parts[1] != parts[2][:2] {
		return "", filestorage.ErrInvalidAddress
	}
	digest := sha256.Sum256([]byte(parts[3]))
	return fmt.Sprintf("%s/%s/%s/%s/%x", bucket, parts[0], parts[1], parts[2], digest), nil
}

func missing(err error) bool {
	var response *azcore.ResponseError
	return errors.As(err, &response) && response.StatusCode == 404 && response.ErrorCode == "BlobNotFound"
}
func readError(err error) error {
	if missing(err) {
		return errors.Join(fs.ErrNotExist, err)
	}
	return err
}
func check(ctx context.Context) error {
	if err := filestorage.GateError(ctx); err != nil {
		return err
	}
	return filestorage.VerifyGates(ctx)
}

type noCloseFile struct{ *os.File }

func (f noCloseFile) Close() error { return nil }

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := filestorage.GateError(r.ctx); err != nil {
		return 0, err
	}
	n, err := r.source.Read(p)
	if gateErr := filestorage.GateError(r.ctx); gateErr != nil {
		return n, errors.Join(err, gateErr)
	}
	return n, err
}

type gateBody struct {
	ctx  context.Context
	body io.ReadCloser
}

func (b gateBody) Read(p []byte) (int, error) { return (contextReader{b.ctx, b.body}).Read(p) }
func (b gateBody) Close() error               { return errors.Join(filestorage.GateError(b.ctx), b.body.Close()) }

// Put stages all input before the single atomic blob publication. A failing
// input or full scratch filesystem cannot overwrite the previous object.
func (s *Storage) Put(ctx context.Context, bucket, path string, content io.Reader) (info filestorage.FileInfo, result error) {
	outcome := filestorage.NotPublished
	defer func() {
		if result != nil {
			result = &filestorage.PublicationError{Outcome: outcome, Cause: result}
		}
	}()
	name, err := BlobName(bucket, path)
	if err != nil {
		return info, err
	}
	if err = check(ctx); err != nil {
		return info, err
	}
	f, err := os.CreateTemp(s.scratch, "daynight-blob-*")
	if err != nil {
		return info, err
	}
	defer func() { result = errors.Join(result, f.Close(), os.Remove(f.Name())) }()
	size, err := io.Copy(f, contextReader{ctx, content})
	if err == nil {
		err = check(ctx)
	}
	if err != nil {
		return info, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return info, err
	}
	if err = check(ctx); err != nil {
		return info, err
	}
	outcome = filestorage.PublicationUnknown
	// A single attempt permits a definite service refusal to remain distinct
	// from a lost response after a possible publication.
	uploadCtx := runtime.WithRetryOptions(ctx, policy.RetryOptions{MaxRetries: -1})
	_, err = s.client.NewBlockBlobClient(name).Upload(uploadCtx, noCloseFile{f}, nil)
	if err != nil {
		var response *azcore.ResponseError
		if errors.As(err, &response) {
			switch response.StatusCode {
			case 400, 401, 403, 404, 409, 412, 413:
				outcome = filestorage.NotPublished
			}
		}
		return info, err
	}
	outcome = filestorage.Published
	if err = filestorage.GateError(ctx); err != nil {
		return info, err
	}
	return filestorage.FileInfo{Size: size}, nil
}

func (s *Storage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	name, err := BlobName(bucket, path)
	if err != nil {
		return filestorage.Object{}, err
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, err
	}
	response, err := s.client.NewBlobClient(name).DownloadStream(ctx, nil)
	if err != nil {
		return filestorage.Object{}, readError(err)
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, errors.Join(err, response.Body.Close())
	}
	if response.ContentLength == nil || response.ETag == nil {
		return filestorage.Object{}, errors.Join(errors.New("Azure response lacks length or ETag"), response.Body.Close())
	}
	return filestorage.Object{Body: gateBody{ctx, response.NewRetryReader(ctx, nil)}, Info: filestorage.FileInfo{Size: *response.ContentLength}}, nil
}

func (s *Storage) Delete(ctx context.Context, bucket, path string) error {
	name, err := BlobName(bucket, path)
	if err != nil {
		return err
	}
	if err = check(ctx); err != nil {
		return err
	}
	_, err = s.client.NewBlobClient(name).Delete(ctx, nil)
	if missing(err) {
		err = nil
	}
	return errors.Join(err, filestorage.GateError(ctx))
}

// sweep exhausts every page and checks each delete before reporting success.
func (s *Storage) sweep(ctx context.Context, bucket, prefix string) error {
	if err := check(ctx); err != nil {
		return err
	}
	prefix = bucket + "/" + prefix + "/"
	pager := s.client.NewListBlobsFlatPager(&container.ListBlobsFlatOptions{Prefix: &prefix, MaxResults: s.pageSize})
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return err
		}
		if page.Segment == nil {
			return errors.New("Azure listing lacks segment")
		}
		for _, item := range page.Segment.BlobItems {
			if item == nil || item.Name == nil || !strings.HasPrefix(*item.Name, prefix) {
				return errors.New("Azure listing returned invalid object name")
			}
			if err = check(ctx); err != nil {
				return err
			}
			_, err = s.client.NewBlobClient(*item.Name).Delete(ctx, nil)
			if err != nil && !missing(err) {
				return err
			}
		}
	}
	return filestorage.GateError(ctx)
}
func (s *Storage) DeleteSessionArchives(ctx context.Context, n sessionarchive.Namespace) error {
	if err := n.Validate(); err != nil {
		return errors.Join(filestorage.ErrInvalidAddress, err)
	}
	return s.sweep(ctx, sessionarchive.Bucket, n.Directory())
}
func (s *Storage) DeleteSessionResources(ctx context.Context, n sessionresource.Namespace) error {
	if n.Directory() == "" {
		return filestorage.ErrInvalidAddress
	}
	return s.sweep(ctx, sessionresource.Bucket, n.Directory())
}
func (s *Storage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, id string) error {
	p, err := n.UploadPath(id)
	if err != nil {
		return errors.Join(filestorage.ErrInvalidAddress, err)
	}
	return s.sweep(ctx, sessionresource.Bucket, p)
}

// Remote capacity is accounted for by PostgreSQL budgets, not local volume space.
func (s *Storage) ResourceSpace(ctx context.Context) (int64, int64, error) {
	if err := filestorage.GateError(ctx); err != nil {
		return 0, 0, err
	}
	return math.MaxInt64, math.MaxInt64, nil
}
func (s *Storage) AvailableTransferBytes(ctx context.Context) (int64, error) {
	if err := filestorage.GateError(ctx); err != nil {
		return 0, err
	}
	return math.MaxInt64, nil
}

var _ filestorage.Storage = (*Storage)(nil)
var _ filestorage.ResourceStorage = (*Storage)(nil)
var _ filestorage.UploadStorage = (*Storage)(nil)
var _ filestorage.TransferStorage = (*Storage)(nil)
var _ filestorage.TransferAttachmentPublisher = (*Storage)(nil)
