//go:build stress

package session_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type pgSocketGate struct {
	filestorage.Storage
	entered chan struct{}
}

func (s *pgSocketGate) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	permit, err := s.Storage.TryAcquireArchive(ctx, owner, session, limit, cleanup)
	if err != nil {
		return nil, err
	}
	s.entered <- struct{}{}
	return permit, nil
}

// Real registration, credential and archive metadata preflight run against
// PostgreSQL. HTTP authentication maps test tokens to the saved principals.
func TestArchiveCapacityPostgresAcrossSockets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	gate := &pgSocketGate{Storage: files, entered: make(chan struct{}, 40)}
	engine := core.NewEngine(gate, core.ArchiveLimits{MaxConcurrent: 20, MaxConcurrentPerOwner: 5})
	defer engine.Stop(context.Background())
	svc := sessionservice.New(db, engine)
	principals := map[string]model.Principal{}
	createOwner := func() (string, model.Principal) {
		user := testsupport.ServicePrincipal(t, db)
		id, token := uuid.NewString(), "dnpat_"+uuid.NewString()
		hash := sha256.Sum256([]byte(token))
		_, e := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(business_scopes,scope_version,id,user_id,token_hash,name,created_at,expires_at) VALUES(ARRAY['session:control','session:produce','session:read','session:send'],1,$1,$2,$3,'socket witness',now(),now()+interval '1 day')`, id, user.UserID, hash[:])
		if e != nil {
			t.Fatal(e)
		}
		p := model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: id}
		principals[token] = p
		return token, p
	}
	register := func(p model.Principal) string {
		reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
		result, e := svc.RegisterTest(ctx, p, reg)
		if e != nil {
			t.Fatal(e)
		}
		return result.SessionID
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if p, ok := principals[token]; ok && kind == model.PATCredential {
			return p, nil
		}
		return model.Principal{}, authhttp.Failure()
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	routes := sessionhttp.NewRoutes(svc, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	var finished sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		if len(parts) > 4 {
			if done, ok := finished.Load(parts[4]); ok {
				defer close(done.(chan struct{}))
			}
		}
		mux.ServeHTTP(w, r)
	}))
	defer server.Close()
	defer routes.Shutdown(context.Background())
	type target struct{ id, token string }
	var unique []target
	for i := 0; i < 21; i++ {
		tok, p := createOwner()
		unique = append(unique, target{register(p), tok})
	}
	tok, owner := createOwner()
	var shared []target
	for i := 0; i < 6; i++ {
		shared = append(shared, target{register(owner), tok})
	}
	run := func(targets []target, count int) {
		var conns []net.Conn
		defer func() {
			for _, c := range conns {
				_ = c.Close()
			}
		}()
		var dones []chan struct{}
		start := func(v target) {
			done := make(chan struct{})
			finished.Store(v.id, done)
			c, e := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if e != nil {
				t.Fatal(e)
			}
			conns = append(conns, c)
			if _, e = fmt.Fprintf(c, "PUT /api/v1/test-sessions/%s/archive HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{", v.id, v.token); e != nil {
				t.Fatal(e)
			}
			select {
			case <-gate.entered:
				dones = append(dones, done)
			case <-ctx.Done():
				t.Fatal("admission timed out")
			}
		}
		for _, v := range targets[:count] {
			start(v)
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodPut, server.URL+"/api/v1/test-sessions/"+targets[count].id+"/archive", strings.NewReader("{}"))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Authorization", "Bearer "+targets[count].token)
		req.Header.Set("Content-Type", "application/json")
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if e != nil || resp.StatusCode != 429 || !strings.Contains(string(b), `"resource_busy"`) {
			t.Fatalf("capacity response %d %q %v", resp.StatusCode, b, e)
		}
		_ = conns[0].Close()
		select {
		case <-dones[0]:
		case <-ctx.Done():
			t.Fatal("disconnect did not release")
		}
		start(targets[count])
		_ = conns[len(conns)-1].Close()
		select {
		case <-dones[len(dones)-1]:
		case <-ctx.Done():
			t.Fatal("replacement did not release")
		}
		for i := 1; i < count; i++ {
			_ = conns[i].Close()
		}
		for i := 1; i < count; i++ {
			select {
			case <-dones[i]:
			case <-ctx.Done():
				t.Fatal("drain timed out")
			}
		}
	}
	t.Run("instance", func(t *testing.T) { run(unique, 20) })
	t.Run("owner", func(t *testing.T) { run(shared, 5) })
}
