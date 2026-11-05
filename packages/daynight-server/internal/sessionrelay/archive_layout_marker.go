package sessionrelay

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"os"

	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
)

const SessionArchiveLayoutMarker = ".session-archive-layout.json"
const archiveLayoutMarkerLimit = 128

func (m *archiveLayoutMigration) readCompletionMarker(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, m.failure("canceled", "Archive layout marker check was canceled.", err)
	}
	info, err := m.root.Lstat(SessionArchiveLayoutMarker)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, m.failure("filesystem", "Archive layout marker could not be inspected.", err)
	}
	if !info.Mode().IsRegular() || info.Size() > archiveLayoutMarkerLimit {
		return false, m.failure("invalid_marker", "Archive layout marker must be a small regular JSON file without symlinks.", nil)
	}
	file, err := m.root.Open(SessionArchiveLayoutMarker)
	if err != nil {
		return false, m.failure("filesystem", "Archive layout marker could not be opened.", err)
	}
	opened, statErr := file.Stat()
	if statErr != nil || !os.SameFile(info, opened) {
		return false, m.failure("invalid_marker", "Archive layout marker identity changed while it was opened.", errors.Join(statErr, file.Close()))
	}
	data, readErr := io.ReadAll(io.LimitReader(archiveLayoutReader{ctx, file}, archiveLayoutMarkerLimit+1))
	if err = errors.Join(readErr, file.Close()); err != nil {
		return false, m.failure("filesystem", "Archive layout marker could not be read.", err)
	}
	fields, err := jsonobject.Decode(data, "archive layout marker", "version")
	if err != nil || len(data) > archiveLayoutMarkerLimit || len(fields) != 1 || !bytes.Equal(bytes.TrimSpace(fields["version"]), []byte("1")) {
		return false, m.failure("invalid_marker", "Archive layout marker is invalid or has an unsupported version.", err)
	}
	// A previous publication may have renamed the marker before its directory
	// flush failed. Every startup repeats that barrier before trusting completion.
	if err = m.syncDirectory("."); err != nil {
		return false, err
	}
	return true, nil
}

func (m *archiveLayoutMigration) publishCompletionMarker(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return m.failure("canceled", "Archive layout completion was canceled before publication.", err)
	}
	temporary := SessionArchiveLayoutMarker + ".tmp-" + rand.Text()
	file, err := m.root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return m.failure("filesystem", "Archive layout completion marker could not be created.", err)
	}
	_, writeErr := file.Write([]byte("{\"version\":1}\n"))
	if writeErr == nil {
		writeErr = m.fileSync(file)
	}
	if err = errors.Join(writeErr, file.Close(), ctx.Err()); err != nil {
		return m.failure("filesystem", "Archive layout completion marker could not be persisted.", errors.Join(err, m.root.Remove(temporary)))
	}
	if err = m.root.Rename(temporary, SessionArchiveLayoutMarker); err != nil {
		return m.failure("filesystem", "Archive layout completion marker could not be published.", errors.Join(err, m.root.Remove(temporary)))
	}
	return m.syncDirectory(".")
}
