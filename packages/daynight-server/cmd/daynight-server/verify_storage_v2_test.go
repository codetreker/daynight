//go:build startupshutdown

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

// The command reads independently constructed database and volume state. The
// unaligned on-disk tail is deliberately not treated as a durable resume point.
func TestVerifyStorageCommandSingleFileStaging(t *testing.T) {
	values := processAPIEnvironment(t)
	db, err := postgres.Open(t.Context(), values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const blockSize = 512 * 1024
	cases := []struct {
		name           string
		stored, length int
		damage         string
		version        int
		purpose        string
		want           bool
		offset         int
	}{
		{"partial with tail", blockSize + 7, blockSize + 13, "", 2, "history", true, blockSize},
		{"fully received", blockSize + 13, blockSize + 13, "", 2, "history", true, blockSize + 13},
		{"zero offset", 0, blockSize + 13, "", 2, "history", true, 0},
		{"empty migration resource", 0, 0, "", 2, "resource", true, 0},
		{"empty resource descriptor missing", 0, 0, "missing-descriptor", 2, "resource", false, 0},
		{"empty resource from earlier history", 0, 0, "ledger-mismatch", 2, "resource", true, 0},
		{"missing staging", 0, blockSize + 13, "missing", 2, "history", false, 0},
		{"modified full staging", blockSize + 13, blockSize + 13, "modified", 2, "history", false, 0},
		{"oversized staging", blockSize + 14, blockSize + 13, "oversized", 2, "history", false, 0},
		{"mismatched volume", blockSize, blockSize + 13, "wrong-volume", 2, "history", false, 0},
		{"staging hardlink", blockSize, blockSize + 13, "hardlink", 2, "history", false, 0},
		{"staging directory alias", blockSize + 13, blockSize + 13, "staging-alias", 2, "history", false, 0},
		{"session directory alias", blockSize + 13, blockSize + 13, "session-alias", 2, "history", false, 0},
		{"legacy chunk row", 13, 13, "", 1, "history", true, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			id, owner, execution, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, id)
			if err != nil {
				t.Fatal(err)
			}
			filePath := namespace.Directory() + "/files/" + fileID
			if tc.purpose == "resource" {
				filePath = namespace.Directory() + "/blobs/" + fileID
			}
			contents := make([]byte, tc.length)
			for i := range contents {
				contents[i] = byte((i*37 + 11) % 251)
			}
			fullHash := sha256.Sum256(contents)
			volume := testStorageRoot(t)
			if tc.damage != "missing" {
				staging := filepath.Join(volume, "session-archives", filepath.FromSlash(namespace.Directory()), ".staging", fileID)
				if tc.damage == "wrong-volume" {
					staging = filepath.Join(volume, "session-archives", "users", uuid.NewString(), id[:2], id, ".staging", fileID)
				}
				if tc.version == 1 {
					staging = filepath.Join(volume, "session-archives", filepath.FromSlash(namespace.Directory()), "files", fileID, "chunks", "0")
				}
				if tc.damage == "staging-alias" || tc.damage == "session-alias" {
					sessionDir := filepath.Join(volume, "session-archives", filepath.FromSlash(namespace.Directory()))
					alias := filepath.Join(sessionDir, ".staging")
					if tc.damage == "session-alias" {
						alias = sessionDir
					}
					target := filepath.Join(volume, "session-archives", "alias-target", uuid.NewString())
					if err := os.MkdirAll(filepath.Dir(alias), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.MkdirAll(target, 0o755); err != nil {
						t.Fatal(err)
					}
					relative, err := filepath.Rel(filepath.Dir(alias), target)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(relative, alias); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.MkdirAll(filepath.Dir(staging), 0o755); err != nil {
					t.Fatal(err)
				}
				data := append([]byte(nil), contents[:min(tc.stored, len(contents))]...)
				if tc.damage == "modified" {
					data[0] ^= 0xff
				}
				if tc.damage == "oversized" {
					data = append(data, 0)
				}
				if err := os.WriteFile(staging, data, 0o600); err != nil {
					t.Fatal(err)
				}
				if tc.damage == "hardlink" {
					otherNamespace, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, uuid.NewString())
					if err != nil {
						t.Fatal(err)
					}
					other := filepath.Join(volume, "session-archives", filepath.FromSlash(otherNamespace.Directory()), ".staging", uuid.NewString())
					if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.Link(staging, other); err != nil {
						t.Fatal(err)
					}
				}
			}
			exec := func(query string, args ...any) {
				t.Helper()
				if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
					t.Fatal(err)
				}
			}
			exec(`INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, id, owner, execution)
			t.Cleanup(func() {
				for _, table := range []string{"session_archive_chunks", "session_archive_files", "session_archive_bundles", "task_sessions"} {
					if _, err := db.Pool.Exec(context.Background(), `DELETE FROM `+table+` WHERE `+map[bool]string{true: "id", false: "session_id"}[table == "task_sessions"]+`=$1`, id); err != nil {
						t.Error(err)
					}
				}
			})
			historyID := any(nil)
			ledger := []byte(`{}`)
			resource := []byte("null")
			if tc.purpose == "history" {
				historyID = fileID
			} else if tc.purpose == "resource" {
				length, hash, mime := "0", hex.EncodeToString(fullHash[:]), "application/octet-stream"
				descriptor := sp.Resource{ResourceID: uuid.NewString(), Name: "empty", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
				resource, err = json.Marshal(descriptor)
				if err != nil {
					t.Fatal(err)
				}
				// Independently construct a completed history and its ledger. Its
				// resource has not yet been published and staging is reclaimed.
				entryID, priorID := uuid.NewString(), uuid.NewString()
				entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + entryID + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + descriptor.ResourceID + `","label":"empty"}]}`))
				if err != nil {
					t.Fatal(err)
				}
				ledgerDescriptor := descriptor
				if tc.damage == "ledger-mismatch" {
					ledgerDescriptor.Name = "other"
				}
				history := sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{ledgerDescriptor}}
				historyBytes, err := sp.MarshalWire(history)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = sp.DecodeArchiveHistory(historyBytes); err != nil {
					t.Fatal(err)
				}
				entryBytes, err := sp.MarshalWire(entry)
				if err != nil {
					t.Fatal(err)
				}
				entryDigest := sha256.Sum256(entryBytes)
				var source map[string]any
				if err = json.Unmarshal(entryBytes, &source); err != nil {
					t.Fatal(err)
				}
				delete(source, "revision")
				sourceBytes, err := json.Marshal(source)
				if err != nil {
					t.Fatal(err)
				}
				sourceDigest, historyDigest := sha256.Sum256(sourceBytes), sha256.Sum256(historyBytes)
				ledger, err = json.Marshal(map[string]any{
					"HistoryID": priorID, "HistoryEpoch": "epoch", "SourceThrough": "1", "Sealable": true,
					"Entries":   []any{map[string]any{"i": entryID, "s": "1", "r": "1", "h": hex.EncodeToString(entryDigest[:]), "o": hex.EncodeToString(sourceDigest[:]), "b": len(entryBytes)}},
					"Resources": []sp.Resource{ledgerDescriptor}, "Occurrences": []any{},
				})
				if err != nil {
					t.Fatal(err)
				}
				if tc.damage == "missing-descriptor" {
					resource = []byte("null")
				}
				historyID = priorID
				exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released) VALUES($1,$2,'history',$3,$4,$4,'complete',$5,'null',1,true)`, id, priorID, hex.EncodeToString(historyDigest[:]), len(historyBytes), namespace.Directory()+"/files/"+priorID)
			}
			exec(`INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,resources,ledger,history_id) VALUES($1,$2,'settling',1,'{}','[]',$3,$4)`, id, uuid.NewString(), ledger, historyID)
			if tc.version == 2 {
				exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,upload_version) VALUES($1,$2,$3,$4,$5,0,'receiving',$6,$7,1,2)`, id, fileID, tc.purpose, hex.EncodeToString(fullHash[:]), tc.length, filePath, resource)
			} else {
				exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision) VALUES($1,$2,$3,$4,$5,$6,'receiving',$7,$8,1)`, id, fileID, tc.purpose, hex.EncodeToString(fullHash[:]), tc.length, tc.stored, filePath, resource)
				exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,$3,$4,$5)`, id, fileID, tc.length, hex.EncodeToString(fullHash[:]), namespace.Directory()+"/files/"+fileID+"/chunks/0")
			}
			got, output := runV2BackupVerifierProcess(t, values["DAYNIGHT_DATABASE_URL"], volume)
			if got != tc.want {
				t.Fatalf("verification success = %v, want %v; output: %s", got, tc.want, output)
			}
			if tc.version == 2 && tc.want {
				want := fmt.Sprintf("Session %s file %s recovery offset %d", id, fileID, tc.offset)
				if !strings.Contains(output, want) {
					t.Fatalf("missing %q in verifier output: %s", want, output)
				}
			}
			if tc.name == "partial with tail" {
				// A paired earlier volume can legitimately report a smaller offset
				// with the same immutable database identity.
				backup := testStorageRoot(t)
				if err := os.CopyFS(backup, os.DirFS(volume)); err != nil {
					t.Fatal(err)
				}
				original := filepath.Join(volume, "session-archives", filepath.FromSlash(namespace.Directory()), ".staging", fileID)
				if err := os.WriteFile(original, contents, 0o600); err != nil {
					t.Fatal(err)
				}
				ok, live := runV2BackupVerifierProcess(t, values["DAYNIGHT_DATABASE_URL"], volume)
				wantLive := fmt.Sprintf("Session %s file %s recovery offset %d", id, fileID, tc.length)
				if !ok || !strings.Contains(live, wantLive) {
					t.Fatalf("later volume: %s", live)
				}
				ok, restored := runV2BackupVerifierProcess(t, values["DAYNIGHT_DATABASE_URL"], backup)
				wantBackup := fmt.Sprintf("Session %s file %s recovery offset %d", id, fileID, blockSize)
				if !ok || !strings.Contains(restored, wantBackup) {
					t.Fatalf("paired backup: %s", restored)
				}
			}

		})
	}
}

func runV2BackupVerifierProcess(t *testing.T, database, volume string) (bool, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := testStorageRoot(t)
	writeTestConfig(t, root, map[string]any{"database": map[string]any{"url": database}, "storage": map[string]any{"root": volume}})
	command := exec.CommandContext(ctx, executable, "-test.run=^TestVerifyStorageProcessHelper$")
	if candidate := os.Getenv("DAYNIGHT_TEST_VERIFIER_BINARY"); candidate != "" {
		command = exec.CommandContext(ctx, candidate, "verify-storage", "--root", root)
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "DAYNIGHT_TEST_ROOT="+root, "DAYNIGHT_VERIFY_STORAGE_HELPER=1")
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("backup verifier did not exit: %s", output)
	}
	if err == nil && !strings.Contains(string(output), "Storage backup closure verified.") {
		t.Fatalf("missing closure receipt: %s", output)
	}
	return err == nil, string(output)
}
