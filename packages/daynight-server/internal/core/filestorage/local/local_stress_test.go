//go:build stress

package local

import (
	"bytes"
	"os"
	"sync"
	"testing"
)

func TestStressConcurrentOverwritesNeverExposePartialContent(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only and cannot run in CI")
	}
	storage, root := newStorage(t)
	contents := [][]byte{
		bytes.Repeat([]byte("first"), 10_000),
		bytes.Repeat([]byte("second"), 10_000),
		bytes.Repeat([]byte("third"), 10_000),
	}
	put(t, storage, "bucket", "file", contents[0])
	var workers sync.WaitGroup
	failures := make(chan error, len(contents))
	for _, content := range contents {
		workers.Go(func() {
			for range 10 {
				if _, err := storage.Put(t.Context(), "bucket", "file", bytes.NewReader(content)); err != nil {
					failures <- err
					return
				}
			}
		})
	}
	for range 30 {
		got := read(t, storage, "bucket", "file")
		complete := false
		for _, content := range contents {
			complete = complete || bytes.Equal(got, content)
		}
		if !complete {
			t.Errorf("read incomplete content of size %d", len(got))
		}
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	assertNoTemporary(t, root)
}
