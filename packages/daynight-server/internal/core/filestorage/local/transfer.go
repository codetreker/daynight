package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

const transferBucket = "mcp-transfers"

var _ filestorage.TransferStorage = (*Storage)(nil)

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
