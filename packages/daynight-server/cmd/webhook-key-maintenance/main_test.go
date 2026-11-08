package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestMaintenanceCommand(t *testing.T) {
	ctx := context.Background()
	sourceURL := testutil.ScopedDatabaseURL(t)
	restoreURL := testutil.ScopedDatabaseURL(t)
	source, err := postgres.Open(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	restored, err := postgres.Open(ctx, restoreURL)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	master := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	oldFile := filepath.Join(t.TempDir(), "old.json")
	newOnlyFile := filepath.Join(t.TempDir(), "new-only.json")
	newFile := filepath.Join(t.TempDir(), "new.json")
	oldData := fmt.Sprintf(`{"activeKeyId":"old","keys":{"old":%q,"new":%q}}`, master, master)
	newData := fmt.Sprintf(`{"activeKeyId":"new","keys":{"old":%q,"new":%q}}`, master, master)
	if err = os.WriteFile(oldFile, []byte(oldData), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(newOnlyFile, []byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, master)), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(newFile, []byte(newData), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"DAYNIGHT_DATABASE_URL": sourceURL, "DAYNIGHT_RESTORED_DATABASE_URL": restoreURL, "DAYNIGHT_WEBHOOK_KEYRING_FILE": oldFile, "DAYNIGHT_RESTORED_WEBHOOK_KEYRING_FILE": newOnlyFile}
	t.Setenv("DAYNIGHT_DATABASE_URL", sourceURL)
	savedArgs, savedOut := os.Args, os.Stdout
	reader, writer, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}
	os.Args = []string{"webhook-key-maintenance"}
	os.Stdout = writer
	main()
	os.Args = savedArgs
	os.Stdout = savedOut
	writer.Close()
	output, pipeErr := io.ReadAll(reader)
	reader.Close()
	if pipeErr != nil || !bytes.Contains(output, []byte(`"retirementSafe":false`)) {
		t.Fatalf("main output %s: %v", output, pipeErr)
	}
	savedArgs, savedErr := os.Args, os.Stderr
	errReader, errWriter, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatal(pipeErr)
	}
	os.Args = []string{"webhook-key-maintenance", "--invalid"}
	os.Stderr = errWriter
	savedExit := exit
	code := 0
	exit = func(c int) { code = c }
	main()
	exit = savedExit
	os.Args = savedArgs
	os.Stderr = savedErr
	_ = errWriter.Close()
	errorsOut, pipeErr := io.ReadAll(errReader)
	_ = errReader.Close()
	if pipeErr != nil || code != 1 || !bytes.Contains(errorsOut, []byte("invalid arguments")) {
		t.Fatalf("main error code=%d output=%s err=%v", code, errorsOut, pipeErr)
	}
	get := func(k string) string { return env[k] }
	out := new(bytes.Buffer)
	if err = run(ctx, nil, get, out); err != nil || !strings.Contains(out.String(), `"retirementSafe":false`) {
		t.Fatalf("inventory %s %v", out, err)
	}
	for _, args := range [][]string{{"--bad"}, {"--mode=unknown"}, {"extra"}} {
		if err = run(ctx, args, get, io.Discard); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if err = run(ctx, nil, func(string) string { return "" }, io.Discard); err == nil {
		t.Fatal("missing db")
	}
	if _, err = loadKeyring(""); err == nil {
		t.Fatal("missing file")
	}
	if _, err = loadKeyring(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("unreadable file")
	}
	invalid := filepath.Join(t.TempDir(), "invalid")
	if err = os.WriteFile(invalid, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadKeyring(invalid); err == nil {
		t.Fatal("invalid keyring")
	}
	if err = run(ctx, nil, get, brokenWriter{}); err == nil {
		t.Fatal("missing output error")
	}
	owner, endpoint, keyID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	keyring, err := secretbox.Parse([]byte(oldData))
	if err != nil {
		t.Fatal(err)
	}
	box, err := keyring.Seal([]byte("https://example.test/secret"), []string{"personal", owner, endpoint, "endpoint-current", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, box.Version, box.MasterKeyID, box.Nonce, box.Ciphertext, keyID)
	if err != nil {
		t.Fatal(err)
	}
	var sourceSchema, restoreSchema string
	if err = source.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&sourceSchema); err != nil {
		t.Fatal(err)
	}
	if err = restored.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&restoreSchema); err != nil {
		t.Fatal(err)
	}
	_, err = source.Pool.Exec(ctx, fmt.Sprintf("INSERT INTO %s.webhook_endpoints SELECT * FROM %s.webhook_endpoints", pgx.Identifier{restoreSchema}.Sanitize(), pgx.Identifier{sourceSchema}.Sanitize()))
	if err != nil {
		t.Fatal(err)
	}
	if err = run(ctx, []string{"--mode=verify-restore", "--old-master=old"}, get, io.Discard); err == nil {
		t.Fatal("old backup accepted")
	}
	env["DAYNIGHT_DATABASE_URL"] = restoreURL
	env["DAYNIGHT_WEBHOOK_KEYRING_FILE"] = newFile
	out.Reset()
	if err = run(ctx, []string{"--mode=rewrap", "--old-master=old"}, get, out); err != nil || !strings.Contains(out.String(), `"Rewrapped":1`) {
		t.Fatalf("rewrap %s %v", out, err)
	}
	if err = run(ctx, []string{"--mode=rewrap", "--old-master=new"}, get, io.Discard); err == nil {
		t.Fatal("active master accepted")
	}
	env["DAYNIGHT_DATABASE_URL"] = sourceURL
	env["DAYNIGHT_WEBHOOK_KEYRING_FILE"] = oldFile
	out.Reset()
	if err = run(ctx, []string{"--mode=verify-restore", "--old-master=old"}, get, out); err == nil || !strings.Contains(err.Error(), "not independent") {
		t.Fatalf("same database with different DSN accepted %s %v", out, err)
	}
	env["DAYNIGHT_RESTORED_DATABASE_URL"] = sourceURL
	if err = run(ctx, []string{"--mode=verify-restore"}, get, io.Discard); err == nil {
		t.Fatal("same database accepted")
	}
}
