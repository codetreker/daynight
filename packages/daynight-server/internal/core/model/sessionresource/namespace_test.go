package sessionresource

import (
	"strings"
	"testing"
)

func TestResourceNamespacePreservesScopeAndRejectsPaths(t *testing.T) {
	owner := "11111111-1111-4111-8111-111111111111"
	session := "22222222-2222-4222-8222-222222222222"
	blob := "aaaaaaaa-3333-4333-8333-333333333333"
	n, err := NewNamespace("", owner, session)
	if err != nil {
		t.Fatal(err)
	}
	path, err := n.BlobPath(blob)
	if err != nil || path != "users/"+owner+"/22/"+session+"/blobs/"+blob {
		t.Fatalf("path=%q err=%v", path, err)
	}
	project, err := NewNamespace(owner, session, session)
	if err != nil || !strings.HasPrefix(project.Directory(), "projects/"+owner+"/") {
		t.Fatalf("project=%v err=%v", project, err)
	}
	for _, bad := range []string{"", "../blob", strings.ToUpper(blob), "00000000-0000-0000-0000-000000000000"} {
		if _, err := n.BlobPath(bad); err == nil {
			t.Errorf("accepted blob %q", bad)
		}
	}
	if _, err := NewNamespace("../project", owner, session); err == nil {
		t.Fatal("accepted a path as owner")
	}
	if _, err := n.ChunkPath(blob, -1); err == nil {
		t.Fatal("accepted a negative chunk offset")
	}
	if _, err := n.ChunkPath("../upload", 0); err == nil {
		t.Fatal("accepted an unsafe upload identity")
	}
	if path, err := n.ChunkPath(blob, 262144); err != nil || path != "users/"+owner+"/22/"+session+"/uploads/"+blob+"/262144" {
		t.Fatalf("chunk path=%q err=%v", path, err)
	}
}
