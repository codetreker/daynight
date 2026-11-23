//go:build startupshutdown

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
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

// Construct the restored volume and proof independently of the archive writer.
// A receiving file may have a durable but unacknowledged next block; that block
// is not required for recovery, including when its contents are unrelated.
func TestVerifyStorageCommandNumberedArchiveBlocks(t *testing.T) {
	values := processAPIEnvironment(t)
	db, err := postgres.Open(t.Context(), values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const blockSize = 512 * 1024
	cases := []struct {
		name              string
		confirmed, length int
		damage            string
		version           int
		purpose           string
		want              bool
	}{
		{"partial", blockSize, blockSize + 13, "unconfirmed", 2, "history", true},
		{"fully received", blockSize + 13, blockSize + 13, "", 2, "history", true},
		{"zero offset", 0, blockSize + 13, "", 2, "history", true},
		{"empty migration resource", 0, 0, "", 2, "resource", true},
		{"empty resource descriptor missing", 0, 0, "missing-descriptor", 2, "resource", false},
		{"empty resource from earlier history", 0, 0, "ledger-mismatch", 2, "resource", true},
		{"missing confirmed block", blockSize + 13, blockSize + 13, "missing", 2, "history", false},
		{"modified confirmed block", blockSize + 13, blockSize + 13, "modified", 2, "history", false},
		{"mismatched volume", blockSize, blockSize + 13, "wrong-volume", 2, "history", false},
		{"legacy chunk row", 13, 13, "", 1, "history", true},
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
			proof := sha256.Sum256([]byte("daynight-archive-prefix-v2"))
			volume := testStorageRoot(t)
			writeBlock := func(offset int, data []byte) {
				t.Helper()
				path := filepath.Join(volume, "session-archives", filepath.FromSlash(namespace.Directory()), "files", fileID, "chunks", fmt.Sprint(offset))
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for offset := 0; offset < tc.confirmed; offset += blockSize {
				end := min(offset+blockSize, tc.confirmed)
				block := contents[offset:end]
				hash := sha256.Sum256(block)
				var encoded [12]byte
				binary.BigEndian.PutUint64(encoded[:8], uint64(offset))
				binary.BigEndian.PutUint32(encoded[8:], uint32(len(block)))
				h := sha256.New()
				h.Write(proof[:])
				h.Write(encoded[:])
				h.Write(hash[:])
				copy(proof[:], h.Sum(nil))
				if tc.damage != "wrong-volume" && !(tc.damage == "missing" && offset == 0) {
					if tc.damage == "modified" && offset == 0 {
						block = append([]byte(nil), block...)
						block[0] ^= 0xff
					}
					writeBlock(offset, block)
				}
			}
			if tc.damage == "unconfirmed" {
				writeBlock(tc.confirmed, []byte("unconfirmed bytes"))
			}
			if tc.damage == "wrong-volume" {
				other := filepath.Join(volume, "session-archives", "users", uuid.NewString(), id[:2], id, "files", fileID, "chunks", "0")
				if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(other, contents[:tc.confirmed], 0o600); err != nil {
					t.Fatal(err)
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
				exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,upload_version,prefix_proof) VALUES($1,$2,$3,$4,$5,$6,'receiving',$7,$8,1,2,$9)`, id, fileID, tc.purpose, hex.EncodeToString(fullHash[:]), tc.length, tc.confirmed, filePath, resource, proof[:])
			} else {
				exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision) VALUES($1,$2,$3,$4,$5,$6,'receiving',$7,$8,1)`, id, fileID, tc.purpose, hex.EncodeToString(fullHash[:]), tc.length, tc.confirmed, filePath, resource)
				exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,$3,$4,$5)`, id, fileID, tc.length, hex.EncodeToString(fullHash[:]), namespace.Directory()+"/files/"+fileID+"/chunks/0")
			}
			got, output := runV2BackupVerifierProcess(t, values["DAYNIGHT_DATABASE_URL"], volume)
			if got != tc.want {
				t.Fatalf("verification success = %v, want %v; output: %s", got, tc.want, output)
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
