//go:build stress

package mcpdownload

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/google/uuid"
)

func processReadChars(t *testing.T) uint64 {
	t.Helper()
	data, err := os.ReadFile("/proc/self/io")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "rchar: "); ok {
			n, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
	}
	t.Fatal("rchar missing")
	return 0
}

func TestStressDownloadLargeSnapshotAndDirectRange(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only and cannot run in CI")
	}
	if runtime.GOOS != "linux" {
		t.Skip("read accounting requires Linux /proc")
	}
	f := newAcceptanceFixture(t)
	data := bytes.Repeat([]byte("0123456789abcdef"), 4<<20)
	f.put(t, data)
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	opened, err := f.service.Read(t.Context(), f.actor, in)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if opened["sha256"] != hex.EncodeToString(sum[:]) || opened["totalBytes"] != strconv.Itoa(len(data)) {
		t.Fatalf("snapshot: %#v", opened)
	}
	in.Action, in.Offset, in.Format, in.MaxBytes = "chunk", strconv.Itoa(len(data)-4096), "base64", 4096
	result, err := f.service.Read(t.Context(), f.actor, in)
	if err != nil {
		t.Fatal(err)
	}
	last, err := base64.StdEncoding.DecodeString(result["contentBase64"].(string))
	if err != nil || !bytes.Equal(last, data[len(data)-4096:]) || result["eof"] != true {
		t.Fatalf("last range: %#v %v", result, err)
	}
	ns, err := filestorage.NewTransferNamespace(in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	before := processReadChars(t)
	const iterations = 128
	for i := 0; i < iterations; i++ {
		obj, err := f.files.OpenTransferRange(permit.Context, ns, in.TransferID, int64(len(data)-4096), 4096)
		if err != nil {
			t.Fatal(err)
		}
		part, readErr := io.ReadAll(obj.Body)
		closeErr := obj.Body.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(part, data[len(data)-4096:]) {
			t.Fatalf("range %d: %v %v", i, readErr, closeErr)
		}
	}
	read := processReadChars(t) - before
	if read > iterations*4096+1<<20 {
		t.Fatalf("range reads consumed %d bytes; seeking must not scan the prefix", read)
	}
	t.Logf("64 MiB snapshot, %d 4 KiB tail reads consumed %d kernel-read bytes", iterations, read)
}
