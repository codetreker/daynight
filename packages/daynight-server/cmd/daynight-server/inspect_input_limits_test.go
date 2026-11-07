//go:build unix

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/inputpolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func TestInspectionProvenanceMatchesSources(t *testing.T) {
	source := currentInspectionSource()
	if source.SHA == "" && !source.Modified {
		t.Fatal("unidentified source treated as clean")
	}
	clean := inspectionSourceFromBuildInfo(&debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.revision", Value: "revision"}, {Key: "vcs.modified", Value: "false"}, {Key: "other", Value: "ignored"}}}, true)
	if clean.SHA != "revision" || clean.Modified {
		t.Fatalf("clean source: %+v", clean)
	}
	if !inspectionSourceFromBuildInfo(nil, false).Modified {
		t.Fatal("missing build metadata treated as clean")
	}
	if !inspectionSourceFromBuildInfo(&debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.modified", Value: "true"}}}, true).Modified {
		t.Fatal("modified source treated as clean")
	}
	for _, tc := range []struct{ file, want string }{
		{"../../../../docs/spec/daynight-api-input-limits.md", inputSpecSHA},
	} {
		data, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatal(err)
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(data)); actual != tc.want {
			t.Fatalf("%s hash = %s, expected %s", tc.file, actual, tc.want)
		}
	}
}

func TestInspectionIdentityFailures(t *testing.T) {
	root := t.TempDir()
	if _, err := storageIdentity(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing storage accepted")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := storageIdentity(file); err == nil {
		t.Fatal("file as storage root accepted")
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storageRootFingerprint(file, info); err == nil {
		t.Fatal("non-directory fingerprinted")
	}
	if err := (&identityVisitor{}).Record(store.InputLimitsRecord{}); err == nil {
		t.Fatal("unexpected candidate accepted")
	}
}

func TestPolicyDigestTracksValues(t *testing.T) {
	entries := inputpolicy.Catalog()
	initial := policyDigest(inputpolicy.Version, entries)
	entries[0].Max++
	if initial == policyDigest(inputpolicy.Version, entries) || initial == policyDigest(inputpolicy.Version+"-new", inputpolicy.Catalog()) {
		t.Fatal("policy identity ignored changed policy")
	}
}

func TestInspectionReportRejectsSpecialFilesAndCancellation(t *testing.T) {
	root := t.TempDir()
	fifo := filepath.Join(root, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	if file, err := openInspectionReport(fifo); err == nil {
		file.Close()
		t.Fatal("FIFO accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := (contextReader{ctx: ctx, reader: strings.NewReader("input")}).Read(make([]byte, 8)); !errors.Is(err, context.Canceled) {
		t.Fatalf("read cancellation = %v", err)
	}
}

func TestInspectionCommandRejectsUnsafeFailures(t *testing.T) {
	for _, args := range [][]string{{"inspect-input-limits", "bad-secret"}, {"inspect-input-limits", "--verify-report", "file", "--writers-stopped-since", "invalid"}} {
		var output, logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		code := runInputLimitsInspection(t.Context(), args, func(key string) string {
			if key == "DAYNIGHT_DATABASE_URL" {
				return "postgres://user:top-secret@bad%host/db"
			}
			return t.TempDir()
		}, &output, logger)
		if code != 1 || output.Len() != 0 || strings.Contains(logs.String(), "secret") {
			t.Fatalf("unsafe failure: %d %q %q", code, output.String(), logs.String())
		}
	}
	if got := runInputLimitsInspection(t.Context(), []string{"inspect-input-limits"}, func(string) string { return "" }, io.Discard, slog.New(slog.NewTextHandler(io.Discard, nil))); got != 1 {
		t.Fatalf("missing config = %d", got)
	}
}

func TestInspectionStatNeverFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "bucket"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "bucket", "file")
	if err := os.WriteFile(file, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("file", filepath.Join(dir, "bucket", "alias")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if size, err := inspectionStat(t.Context(), root, "bucket", "file"); err != nil || size != 7 {
		t.Fatalf("stat = %d, %v", size, err)
	}
	if _, err := inspectionStat(t.Context(), root, "bucket", "alias"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("symlink = %v", err)
	}
	if _, err := inspectionStat(t.Context(), root, "bucket", "../file"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid = %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := inspectionStat(ctx, root, "bucket", "file"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
}

func TestStorageIdentityDetectsRootReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "storage")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	before, err := storageIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, filepath.Join(parent, "original")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	after, err := storageIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("replacement root retained identity")
	}
}

func TestInspectionAndActivationBinding(t *testing.T) {
	values := processAPIEnvironment(t)
	db, err := postgres.Open(t.Context(), values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	start := time.Now().Add(-time.Second)
	source := inspectionSource{SHA: strings.Repeat("a", 40)}
	var report bytes.Buffer
	if err := inspectInputLimits(t.Context(), values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], &report, source); err != nil {
		t.Fatalf("inspection: %v; %s", err, report.String())
	}
	path := filepath.Join(testStorageRoot(t), "report.jsonl")
	if err := os.WriteFile(path, report.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	verify := func(root string, from time.Time, revision inspectionSource) error {
		return verifyInputLimits(t.Context(), values["DAYNIGHT_DATABASE_URL"], root, path, from, revision)
	}
	if err := verify(values["DAYNIGHT_STORAGE_ROOT"], start, source); err != nil {
		t.Fatalf("current report: %v; %s", err, report.String())
	}
	if err := verifyInputLimits(t.Context(), values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], filepath.Join(t.TempDir(), "missing"), start, source); err == nil {
		t.Fatal("missing report accepted")
	}
	if err := verifyInputLimits(t.Context(), "not-a-connection", values["DAYNIGHT_STORAGE_ROOT"], path, start, source); err == nil {
		t.Fatal("invalid database accepted")
	}
	if err := verifyInputLimits(t.Context(), values["DAYNIGHT_DATABASE_URL"], filepath.Join(t.TempDir(), "missing"), path, start, source); err == nil {
		t.Fatal("missing root accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := verifyInputLimits(ctx, values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_STORAGE_ROOT"], path, start, source); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled verification = %v", err)
	}
	for _, tc := range []struct {
		root   string
		from   time.Time
		source inspectionSource
	}{
		{values["DAYNIGHT_STORAGE_ROOT"], start, inspectionSource{SHA: strings.Repeat("b", 40)}},
		{values["DAYNIGHT_STORAGE_ROOT"], time.Now().Add(time.Second), source},
		{testStorageRoot(t), start, source},
		{values["DAYNIGHT_STORAGE_ROOT"], start, inspectionSource{SHA: source.SHA, Modified: true}},
	} {
		if err := verify(tc.root, tc.from, tc.source); err == nil {
			t.Fatalf("mismatched report accepted: %+v", tc)
		}
	}
}
