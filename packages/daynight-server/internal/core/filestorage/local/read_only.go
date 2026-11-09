package local

import (
	"context"
	"io"
	"io/fs"
	"os"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

type ReadOnlyStorage struct{ storage *Storage }

func (s *ReadOnlyStorage) Close() error { return s.storage.Close() }
func (s *ReadOnlyStorage) Open(ctx context.Context, bucket, name string) (filestorage.Object, error) {
	return s.storage.Open(ctx, bucket, name)
}
func (*ReadOnlyStorage) Put(context.Context, string, string, io.Reader) (filestorage.FileInfo, error) {
	return filestorage.FileInfo{}, fs.ErrPermission
}
func (*ReadOnlyStorage) Delete(context.Context, string, string) error { return fs.ErrPermission }

// OpenReadOnly opens an existing backup volume without initialization, probes,
// gates or filesystem writes. The returned capability only exposes reads.
func OpenReadOnly(root string) (*ReadOnlyStorage, error) {
	directory, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	return &ReadOnlyStorage{storage: &Storage{root: directory, exactSpelling: true}}, nil
}
