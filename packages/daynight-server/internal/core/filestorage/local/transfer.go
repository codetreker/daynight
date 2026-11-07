package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

const transferBucket = "mcp-transfers"

var _ filestorage.TransferStorage = (*Storage)(nil)
var _ filestorage.TransferAttachmentPublisher = (*Storage)(nil)

func (s *Storage) PutTransfer(ctx context.Context, namespace filestorage.TransferNamespace, objectID string, content io.Reader) (filestorage.FileInfo, error) {
	path, err := namespace.ObjectPath(objectID)
	if err != nil {
		return filestorage.FileInfo{}, err
	}
	return s.Put(ctx, transferBucket, path, content)
}

func (s *Storage) OpenTransfer(ctx context.Context, namespace filestorage.TransferNamespace, objectID string) (filestorage.Object, error) {
	path, err := namespace.ObjectPath(objectID)
	if err != nil {
		return filestorage.Object{}, err
	}
	return s.Open(ctx, transferBucket, path)
}

func (s *Storage) PublishTransferAttachment(ctx context.Context, namespace filestorage.TransferNamespace, objectID string, target filestorage.TransferAttachmentTarget) (result error) {
	outcome := filestorage.NotPublished
	defer func() {
		if result != nil {
			result = &filestorage.PublicationError{Outcome: outcome, Cause: result}
		}
	}()
	object, err := namespace.ObjectPath(objectID)
	if err != nil {
		return err
	}
	source, err := checkedAddress(ctx, transferBucket, object)
	if err != nil {
		return err
	}
	destination, err := checkedAddress(ctx, "task-attachments", target.Path())
	if err != nil {
		return err
	}
	s.namespace.Lock()
	defer s.namespace.Unlock()
	for _, directory := range []string{transferBucket, transferBucket + "/" + namespace.ID()[:2], transferBucket + "/" + namespace.Directory()} {
		info, err := s.root.Lstat(directory)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%w: %s", filestorage.ErrNotRegular, directory)
		}
	}
	if err := s.checkSpelling(source); err != nil {
		return err
	}
	if err := s.regular(source); err != nil {
		return err
	}
	if err := s.checkSpelling(destination); err != nil {
		return err
	}
	if err := s.root.MkdirAll(path.Dir(destination), 0o700); err != nil {
		return err
	}
	if err := s.fileTarget(destination, true); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	outcome = filestorage.PublicationUnknown
	if err := s.root.Rename(source, destination); err != nil {
		return err
	}
	outcome = filestorage.Published
	// The source removal and destination publication both need durable entries.
	for _, name := range []string{source, destination} {
		for directory := path.Dir(name); ; directory = path.Dir(directory) {
			file, err := s.root.Open(directory)
			if err != nil {
				return err
			}
			if err := errors.Join(s.fileSync(file), file.Close()); err != nil {
				return err
			}
			if directory == "." {
				break
			}
		}
	}
	return nil
}

type rangeBody struct {
	reader io.Reader
	closer io.Closer
}

func (b *rangeBody) Read(p []byte) (int, error) { return b.reader.Read(p) }
func (b *rangeBody) Close() error               { return b.closer.Close() }

func (s *Storage) OpenTransferRange(ctx context.Context, namespace filestorage.TransferNamespace, objectID string, offset, length int64) (filestorage.Object, error) {
	if offset < 0 || length < 0 {
		return filestorage.Object{}, fmt.Errorf("%w: negative range", filestorage.ErrInvalidAddress)
	}
	object, err := s.OpenTransfer(ctx, namespace, objectID)
	if err != nil {
		return filestorage.Object{}, err
	}
	file := object.Body.(*contextFile)
	if _, err := file.file.Seek(offset, io.SeekStart); err != nil {
		return filestorage.Object{}, errors.Join(err, object.Body.Close())
	}
	object.Body = &rangeBody{reader: io.LimitReader(file, length), closer: file}
	return object, nil
}

func (s *Storage) DeleteTransferNamespace(ctx context.Context, namespace filestorage.TransferNamespace) error {
	if err := namespace.Validate(); err != nil {
		return err
	}
	components := append([]string{transferBucket}, strings.Split(namespace.Directory(), "/")...)
	return s.deleteNamespace(ctx, components)
}
