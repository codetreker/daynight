package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/google/uuid"
)

type archiveLayoutFile struct {
	name      string
	directory bool
	size      int64
	digest    string
}

var archiveLayoutShard = regexp.MustCompile(`^[a-f0-9]{2}$`)

func (m *archiveLayoutMigration) directoryExists(name string) (bool, error) {
	info, err := m.root.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, m.failure("filesystem", "Archive migration directory could not be inspected.", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, m.failure("unsafe_entry", "Archive migration requires real directories without symlinks.", nil)
	}
	return true, nil
}

func (m *archiveLayoutMigration) readDirectory(ctx context.Context, name string) ([]os.DirEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, m.failure("canceled", "Archive migration was canceled during inventory.", err)
	}
	file, err := m.root.Open(name)
	if err != nil {
		return nil, m.failure("filesystem", "Archive migration directory could not be opened.", err)
	}
	entries, readErr := file.ReadDir(-1)
	if err = errors.Join(readErr, file.Close()); err != nil {
		return nil, m.failure("filesystem", "Archive migration directory could not be listed.", err)
	}
	slices.SortFunc(entries, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return entries, nil
}

func archiveLayoutUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func (m *archiveLayoutMigration) preflight(ctx context.Context, records []*archiveLayoutRecord) error {
	known := map[string]*archiveLayoutRecord{}
	for _, r := range records {
		known[r.id] = r
	}
	exists, err := m.directoryExists(sessionarchive.Bucket)
	if err != nil {
		return err
	}
	if exists {
		entries, err := m.readDirectory(ctx, sessionarchive.Bucket)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if name == string(sessionarchive.Projects) || name == string(sessionarchive.Users) {
				if err := m.inspectGroup(ctx, name, known); err != nil {
					return err
				}
				continue
			}
			r := known[name]
			if !archiveLayoutUUID(name) || r == nil {
				return m.failure("unknown_owner", "Archive storage contains an unknown Session namespace.", nil)
			}
			m.session = r.id
			if _, err := m.directoryExists(sessionarchive.Bucket + "/" + name); err != nil {
				return err
			}
		}
	}
	for _, r := range records {
		m.session = r.id
		oldDirectory := sessionarchive.Bucket + "/" + r.id
		newDirectory := sessionarchive.Bucket + "/" + r.namespace.Directory()
		oldExists, err := m.directoryExists(oldDirectory)
		if err != nil {
			return err
		}
		newExists, err := m.directoryExists(newDirectory)
		if err != nil {
			return err
		}
		if oldExists && newExists {
			return m.failure("path_conflict", "Both old and new Session archive directories exist.", nil)
		}
		if oldExists {
			if r.object != nil && *r.object == r.newPath {
				return m.failure("path_conflict", "Archive metadata points to a missing new directory while old files remain.", nil)
			}
			r.directory = oldDirectory
		} else if newExists {
			r.directory = newDirectory
		} else if r.state != nil && *r.state == "ready" {
			return m.failure("missing_content", "Ready archive has no Session storage directory.", nil)
		} else {
			continue
		}
		r.files, err = m.inventory(ctx, r.directory)
		if err != nil {
			return err
		}
		if r.state != nil && *r.state == "ready" {
			if err := m.verifyArchive(ctx, r); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *archiveLayoutMigration) inspectGroup(ctx context.Context, kind string, known map[string]*archiveLayoutRecord) error {
	group := sessionarchive.Bucket + "/" + kind
	if _, err := m.directoryExists(group); err != nil {
		return err
	}
	owners, err := m.readDirectory(ctx, group)
	if err != nil {
		return err
	}
	for _, owner := range owners {
		if !archiveLayoutUUID(owner.Name()) {
			return m.failure("unsafe_entry", "Archive group contains an invalid owner directory.", nil)
		}
		ownerPath := group + "/" + owner.Name()
		knownOwner := false
		for _, r := range known {
			if strings.HasPrefix(r.namespace.Directory(), kind+"/"+owner.Name()+"/") {
				knownOwner = true
				break
			}
		}
		if !knownOwner {
			return m.failure("unknown_owner", "Archive group has no registered Session ownership.", nil)
		}
		if _, err := m.directoryExists(ownerPath); err != nil {
			return err
		}
		shards, err := m.readDirectory(ctx, ownerPath)
		if err != nil {
			return err
		}
		for _, shard := range shards {
			if !archiveLayoutShard.MatchString(shard.Name()) {
				return m.failure("unsafe_entry", "Archive owner contains an invalid UUID shard directory.", nil)
			}
			shardPath := ownerPath + "/" + shard.Name()
			if _, err := m.directoryExists(shardPath); err != nil {
				return err
			}
			sessions, err := m.readDirectory(ctx, shardPath)
			if err != nil {
				return err
			}
			for _, session := range sessions {
				r := known[session.Name()]
				if r == nil || !archiveLayoutUUID(session.Name()) || sessionarchive.Bucket+"/"+r.namespace.Directory() != shardPath+"/"+session.Name() {
					return m.failure("unknown_owner", "Archive directory does not match a registered Session owner and shard.", nil)
				}
				m.session = r.id
				if _, err := m.directoryExists(shardPath + "/" + session.Name()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

type archiveLayoutReader struct {
	ctx context.Context
	io.Reader
}

func (r archiveLayoutReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(buffer)
}

func (m *archiveLayoutMigration) inventory(ctx context.Context, directory string) ([]archiveLayoutFile, error) {
	files := []archiveLayoutFile{}
	var walk func(string) error
	walk = func(relative string) error {
		if err := ctx.Err(); err != nil {
			return m.failure("canceled", "Archive migration was canceled during file verification.", err)
		}
		name := directory
		if relative != "." {
			if err := filestorage.ValidateAddress(sessionarchive.Bucket, relative); err != nil {
				return m.failure("unsafe_entry", "Archive inventory contains an invalid relative filename.", err)
			}
			name += "/" + relative
		}
		info, err := m.root.Lstat(name)
		if err != nil {
			return m.failure("filesystem", "Archive inventory entry could not be inspected.", err)
		}
		if info.IsDir() {
			files = append(files, archiveLayoutFile{name: relative, directory: true})
			children, err := m.readDirectory(ctx, name)
			if err != nil {
				return err
			}
			for _, child := range children {
				childName := child.Name()
				if relative != "." {
					childName = relative + "/" + childName
				}
				if err := walk(childName); err != nil {
					return err
				}
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return m.failure("unsafe_entry", "Archive inventory contains a symlink or special file.", nil)
		}
		file, err := m.root.Open(name)
		if err != nil {
			return m.failure("filesystem", "Archive file could not be opened for verification.", err)
		}
		opened, statErr := file.Stat()
		if statErr != nil || !os.SameFile(info, opened) {
			return m.failure("content_changed", "Archive file identity changed during verification.", errors.Join(statErr, file.Close()))
		}
		hash := sha256.New()
		count, readErr := io.CopyBuffer(hash, archiveLayoutReader{ctx, file}, make([]byte, 64*1024))
		if err := errors.Join(readErr, file.Close()); err != nil {
			return m.failure("filesystem", "Archive file could not be read for verification.", err)
		}
		if count != info.Size() {
			return m.failure("content_changed", "Archive file length changed during verification.", nil)
		}
		files = append(files, archiveLayoutFile{name: relative, size: count, digest: hex.EncodeToString(hash.Sum(nil))})
		return nil
	}
	if err := walk("."); err != nil {
		return nil, err
	}
	return files, nil
}

func (m *archiveLayoutMigration) verifyArchive(ctx context.Context, r *archiveLayoutRecord) error {
	filename := *r.digest + ".json"
	found := false
	for _, file := range r.files {
		if file.name == filename && !file.directory {
			found = true
			if file.size != *r.size || file.digest != *r.digest {
				return m.failure("content_corrupt", "Ready archive bytes do not match their size and SHA-256 manifest.", nil)
			}
		}
	}
	if !found {
		return m.failure("missing_content", "Ready archive object is missing from its Session directory.", nil)
	}
	file, err := m.root.Open(r.directory + "/" + filename)
	if err != nil {
		return m.failure("filesystem", "Ready archive could not be opened for identity verification.", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(archiveLayoutReader{ctx, file}, sp.MaxArchiveBytes+1))
	if err = errors.Join(readErr, file.Close()); err != nil {
		return m.failure("filesystem", "Ready archive could not be read for identity verification.", err)
	}
	if *r.version == 1 {
		doc, err := sp.DecodeArchive(data)
		if err != nil || doc.SessionID != r.id || r.scope == "task" && (doc.ClaimID != *r.claim || doc.TestExecutionID != "") || r.scope == "test" && (doc.TestExecutionID != *r.test || doc.ClaimID != "") {
			return m.failure("content_corrupt", "Ready Web archive identity or structure does not match its Session.", err)
		}
	} else {
		doc, err := v2.DecodeArchive(data)
		if err != nil || doc.SessionID != r.id || r.project == nil || doc.Owner.ProjectID != *r.project || doc.Owner.OwnerUserID != r.owner || doc.ClaimID != *r.claim || doc.Owner.TaskID != *r.task {
			return m.failure("content_corrupt", "Ready terminal archive identity or structure does not match its Session.", err)
		}
	}
	return nil
}

func (m *archiveLayoutMigration) makeParents(ctx context.Context, name string) error {
	parent := ""
	for _, component := range strings.Split(path.Dir(name), "/") {
		if err := ctx.Err(); err != nil {
			return m.failure("canceled", "Archive migration was canceled while preparing directories.", err)
		}
		if parent != "" {
			parent += "/"
		}
		parent += component
		exists, err := m.directoryExists(parent)
		if err != nil {
			return err
		}
		if !exists {
			if err := m.root.Mkdir(parent, 0o700); err != nil {
				return m.failure("filesystem", "Archive migration parent directory could not be created.", err)
			}
		}
	}
	return nil
}

func (m *archiveLayoutMigration) syncDirectory(name string) error {
	file, err := m.root.Open(name)
	if err != nil {
		return m.failure("filesystem", "Archive migration directory could not be opened for synchronization.", err)
	}
	if err = errors.Join(m.fileSync(file), file.Close()); err != nil {
		return m.failure("filesystem", "Archive migration directory could not be synchronized.", err)
	}
	return nil
}

func (m *archiveLayoutMigration) syncParents(name string) error {
	for {
		if err := m.syncDirectory(name); err != nil {
			return err
		}
		if name == "." {
			return nil
		}
		name = path.Dir(name)
	}
}
