package local

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
)

// OpenArchiveStaging reads a stopped backup without modifying it. Unlike
// general object reads, it rejects symlinks in every namespace component.
func (s *ReadOnlyStorage) OpenArchiveStaging(ctx context.Context, n sessionarchive.Namespace, fileID string) (filestorage.Object, error) {
	return s.storage.OpenArchiveStaging(ctx, n, fileID)
}

func (s *Storage) OpenArchiveStaging(ctx context.Context, n sessionarchive.Namespace, fileID string) (object filestorage.Object, result error) {
	name, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		return filestorage.Object{}, err
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, err
	}
	mount, err := archiveReadRootMount(s.root)
	if err != nil {
		return filestorage.Object{}, err
	}
	components := append([]string{sessionarchive.Bucket}, strings.Split(name, "/")...)
	parent := s.root
	var roots []*os.Root
	defer func() {
		for i := len(roots) - 1; i >= 0; i-- {
			result = errors.Join(result, roots[i].Close())
		}
		if result != nil && object.Body != nil {
			result = errors.Join(result, object.Body.Close())
			object = filestorage.Object{}
		}
	}()
	for _, part := range components[:len(components)-1] {
		dir, _, e := openArchiveDirectory(parent, part)
		if e != nil {
			return filestorage.Object{}, e
		}
		roots = append(roots, dir)
		if e = archiveReadDirectoryMount(mount, dir); e != nil {
			return filestorage.Object{}, e
		}
		parent = dir
	}
	base := components[len(components)-1]
	before, err := parent.Lstat(base)
	if err != nil {
		return filestorage.Object{}, err
	}
	if !before.Mode().IsRegular() {
		return filestorage.Object{}, filestorage.ErrNotRegular
	}
	file, err := parent.Open(base)
	if err != nil {
		return filestorage.Object{}, err
	}
	if err = archiveReadFileMount(mount, file); err != nil {
		return filestorage.Object{}, errors.Join(err, file.Close())
	}
	if err = verifyArchiveStagingFile(file); err != nil {
		return filestorage.Object{}, errors.Join(err, file.Close())
	}
	info, err := file.Stat()
	if err == nil && (!info.Mode().IsRegular() || !os.SameFile(before, info)) {
		err = filestorage.ErrPathConflict
	}
	if err == nil {
		err = filestorage.GateError(ctx)
	}
	if err != nil {
		return filestorage.Object{}, errors.Join(err, file.Close())
	}
	return filestorage.Object{Body: &contextFile{file: file, ctx: ctx}, Info: filestorage.FileInfo{Size: info.Size()}}, nil
}
