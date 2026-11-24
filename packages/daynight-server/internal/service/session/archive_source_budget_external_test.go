package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

func TestArchiveSourceHTTPAndCoreUseActualTwoMiBFrame(t *testing.T) {
	for _, recovering := range []bool{false, true} {
		t.Run(map[bool]string{false: "tail", true: "recover"}[recovering], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			db, owner, _, _, _ := archiveFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			engine := core.NewEngine(files)
			t.Cleanup(func() {
				if e := engine.Stop(context.Background()); e != nil {
					t.Error(e)
				}
				if e := files.Close(); e != nil {
					t.Error(e)
				}
			})
			s := sessionservice.New(db, engine)
			reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
			snapshot, err := s.RegisterTest(ctx, owner, reg)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := s.Grant(ctx, owner, "", "", snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: reg.TestExecutionID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			epoch := uuid.NewString()
			conn, err := s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Provider: reg.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Disconnect(ctx, conn.ControllerFence); err != nil {
				t.Fatal(err)
			}
			_, err = s.StopTest(ctx, owner, snapshot.SessionID, sp.TestStop{Protocol: sp.Protocol, Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}})
			if err != nil {
				t.Fatal(err)
			}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
				if kind != model.PATCredential || token != "test-token" {
					return model.Principal{}, authhttp.Failure()
				}
				return owner, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, logger)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			sessionhttp.NewRoutes(s, &authhttp.Authentication{RequestAuthentication: auth}, logger).RegisterRoutes(mux)
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			fence, _ := json.Marshal(snapshot.Fence)
			payload := func() string {
				return `{"entryId":"` + uuid.NewString() + `","revision":"1","kind":"reasoning","text":"` + strings.Repeat("<", 1_040_000) + `"}`
			}
			events := `[{"sourceSeq":"1","kind":"timeline_upsert","payload":` + payload() + `},{"sourceSeq":"2","kind":"timeline_upsert","payload":` + payload() + `}]`
			body := `{"fence":` + string(fence) + `,"controllerId":"` + reg.ControllerID + `","controllerInstanceId":"` + reg.ControllerInstanceID + `","sourceEpoch":"` + epoch + `",`
			path := "/api/v1/test-sessions/" + snapshot.SessionID + "/archive/source-tail"
			if recovering {
				path += "/recover"
				body += `"oldBatchId":"` + uuid.NewString() + `","recoveryId":"` + uuid.NewString() + `","cutoff":"2",`
			} else {
				body += `"batchId":"` + uuid.NewString() + `",`
			}
			body += `"events":` + events + `}`
			if len(body) >= sp.MaxFrameBytes {
				t.Fatal("fixture too large", len(body))
			}
			body += strings.Repeat(" ", sp.MaxFrameBytes-len(body))
			send := func(body string) int {
				req, e := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, bytes.NewBufferString(body))
				if e != nil {
					t.Fatal(e)
				}
				req.Header.Set("Authorization", "Bearer test-token")
				req.Header.Set("Content-Type", "application/json")
				res, e := server.Client().Do(req)
				if e != nil {
					t.Fatal(e)
				}
				defer res.Body.Close()
				_, _ = io.Copy(io.Discard, res.Body)
				return res.StatusCode
			}
			if got := send(body + " "); got != http.StatusRequestEntityTooLarge {
				t.Fatal("overflow accepted", got)
			}
			var before int64
			if err = db.Pool.QueryRow(ctx, `SELECT last_source_seq FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&before); err != nil || before != 0 {
				t.Fatal("overflow advanced source", before, err)
			}
			if got := send(body); got != http.StatusOK {
				t.Fatal("valid full frame refused", got)
			}
			var after int64
			if err = db.Pool.QueryRow(ctx, `SELECT last_source_seq FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&after); err != nil || after != 2 {
				t.Fatal("full frame not committed", after, err)
			}
		})
	}
}
