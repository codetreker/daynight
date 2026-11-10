// Package sessionresource owns the immutable resource and upload file namespace.
package sessionresource

import (
	"fmt"
	"github.com/google/uuid"
	"strconv"
)

const Bucket = "session-resources"

type Namespace struct{ kind, owner, session string }

func NewNamespace(project, owner, session string) (Namespace, error) {
	n := Namespace{kind: "users", owner: owner, session: session}
	if project != "" {
		n.kind, n.owner = "projects", project
	}
	for _, id := range []string{n.owner, n.session} {
		if err := canonical(id); err != nil {
			return Namespace{}, err
		}
	}
	return n, nil
}

func canonical(id string) error {
	u, err := uuid.Parse(id)
	if err != nil || u == uuid.Nil || u.String() != id {
		return fmt.Errorf("resource namespace requires a nonzero canonical UUID")
	}
	return nil
}

func (n Namespace) Directory() string {
	if canonical(n.owner) != nil || canonical(n.session) != nil || n.kind != "users" && n.kind != "projects" {
		return ""
	}
	return n.kind + "/" + n.owner + "/" + n.session[:2] + "/" + n.session
}

func (n Namespace) BlobPath(id string) (string, error)   { return n.objectPath("blobs", id) }
func (n Namespace) UploadPath(id string) (string, error) { return n.objectPath("uploads", id) }
func (n Namespace) objectPath(kind, id string) (string, error) {
	if n.Directory() == "" {
		return "", fmt.Errorf("invalid resource namespace")
	}
	if err := canonical(id); err != nil {
		return "", err
	}
	return n.Directory() + "/" + kind + "/" + id, nil
}

func (n Namespace) ChunkPath(uploadID string, offset int64) (string, error) {
	if offset < 0 {
		return "", fmt.Errorf("invalid resource offset")
	}
	path, err := n.UploadPath(uploadID)
	if err != nil {
		return "", err
	}
	return path + "/" + strconv.FormatInt(offset, 10), nil
}
